const ActiveDirectory = require('activedirectory');
const Gitlab = require('node-gitlab');
const _ = require('lodash')

var isRunning = false;
var gitlab = undefined;
var ldap = undefined;

module.exports = class Sync {
  constructor(config) {
    this.config = config;
    this.ldap = new ActiveDirectory(config.ldap.options);
    this.gitlab = Gitlab.createPromise(config.gitlab);
  }

  getLdapGroups() {
    return new Promise((resolve, reject) => {

      const options = {
        ...this.config.ldap.options,
        baseDN: `${this.config.ldap.group.path},${this.config.ldap.options.baseDN}`,
        filter: 'cn=*'
      };

      this.ldap.findGroups(options, (err, groups) => {
        if (err == null && groups === undefined) {
          reject('ldap request did not return anything');
          return;
        }

        if (err) {
          reject(err);
          return;
        }

        const processed = groups.filter((group) => {
          return group.cn.includes(this.config.ldap.group.prefix);
        }).map((group) => {
          return {
            name: group.cn
          }
        });

        resolve(processed);
      });
    });
  }

  _getLdapUsers(name) {
    return new Promise((resolve, reject) => {
      this.ldap.getUsersForGroup(name, (err, users) => {
        if (err == null && users === undefined) {
          reject('ldap request did not return anything');
          return;
        }

        if (err) {
          reject(err);
          return;
        }

        const members = [];
        for (let user of users) {
          members.push({
            username: user.sAMAccountName.toLowerCase()
          });
        }

        resolve(members);
      });
    });
  }

  async getLdapUsers(groups) {
    const result = {};

    const requests = groups.map((group) => {
      const {name} = group;
      const processedName = name.replace(new RegExp(`^${this.config.ldap.group.prefix}`), '')
      result[processedName] = [];

      return this._getLdapUsers(name).then(users => {
        result[processedName] = users;
      });
    });

    await Promise.all(requests);

    return result;
  }

  getGitlabGroups() {
    return this.gitlab.groups.list({ per_page: 9999999 });
  }

  async getGitlabUsers(groups) {
    const result = {
      ldap: {}
    };

    const userList = await this.gitlab.users.list({ per_page: 999999 })

    userList.forEach(user => {
      const is = user.identities.some((identity) => identity.provider === 'ldapmain');

      if (is) {
        result.ldap[user.username] = user;
      }
    });;

    const requests = groups.map((group) => {
      result[group.name] = [];

      return this.gitlab.groupMembers.list({
        id: group.id,
        per_page: 999999
      }).then(users => {
        const processedUsers = users.filter((user) => result.ldap[user.username]);

        result[group.name] = {
          id: group.id,
          users: processedUsers
        };
      });
    });

    await Promise.all(requests);

    return result;
  }

  async getGroups() {
    const [ldap, gitlab] = await Promise.all([
      this.getLdapGroups(),
      this.getGitlabGroups()
    ]);

    return {
      ldap,
      gitlab
    }
  }

  async getUsers(ldapGroups, gitlabGroups) {
    const [ldap, gitlab] = await Promise.all([
      this.getLdapUsers(ldapGroups),
      this.getGitlabUsers(gitlabGroups)
    ]);

    return {
      ldap,
      gitlab
    }
  }

  getNewGroups(ldap, gitlab) {
    const processedLdap = ldap.map((group) => {
      return {
        name: group.name.replace(new RegExp(`^${this.config.ldap.group.prefix}`), '')
      }
    });

    return _.differenceBy(processedLdap, gitlab, 'name');
  }

  getDiffUsers(ldapUsers, gitlabUsers) {
    let remove = [];
    let add = [];

    const intersection = _.intersection(
      Object.keys(ldapUsers),
      Object.keys(gitlabUsers)
    );

    intersection.forEach((name) => {
      const ldap = ldapUsers[name];
      const { users: gitlab, id } = gitlabUsers[name];

      let ids = _.differenceBy(gitlab, ldap, 'username').map(value => value.id);
      remove.push({
        id,
        name,
        ids
      });

      ids = _.differenceBy(ldap, gitlab, 'username').reduce((acc, ldapUser) => {
        if (ldapUser.username in gitlabUsers.ldap) {
          acc.push(gitlabUsers.ldap[ldapUser.username].id);
        }

        return acc;
      }, []);

      add.push({
        id,
        name,
        ids
      });
    });

    return {
      remove,
      add
    }
  }

 async makeRootAnOwner(groups) {
   const requests = groups.map((group) => {
      return group.ids.map((id) => {
        return this.gitlab.groupMembers.create({
          id: group.id,
          'user_id': 1,
          'access_level': 50
        }).catch(() => {

          // If its already there but doesn't have right permissions
          return this.gitlab.groupMembers.update({
            id: group.id,
            'user_id': 1,
            'access_level': 50
          })
        });
      });
    });

    return Promise.all(requests);
  }

  async removeUsers(groups) {
    await this.makeRootAnOwner(groups);

    const requests = groups.map((group) => {
      return group.ids.map((id) => {
        return this.gitlab.groupMembers.remove({
          id: group.id,
          'user_id': id
        });
      });
    });

    return Promise.all(requests);
  }

  addUsers(list) {
    const requests = list.map((group) => {
      return group.ids.map((id) => {
        return this.gitlab.groupMembers.create({
          id: group.id,
          'user_id': id,
          access_level: 30
        });
      });
    });

    return Promise.all(requests);
  }

  createGroups(groups) {
    const requests = groups.map((group) => {
      return this.gitlab.groups.create({
        name: group.name,
        path: group.name
      });
    });

    return Promise.all(requests);
  }

  async fillGroups() {
    const {
      ldap,
      gitlab
    } = await this.getGroups();

    const newGroups = this.getNewGroups(ldap, gitlab);

    return this.createGroups(newGroups);
  }

  async syncGroups() {
    await this.fillGroups();

    const {
      ldap,
      gitlab
    } = await this.getGroups();

    const {
      ldap: ldapUsers,
      gitlab: gitlabUsers
    } = await this.getUsers(ldap, gitlab);

    const diffUsers = this.getDiffUsers(ldapUsers, gitlabUsers);

    const requests = [
      this.removeUsers(diffUsers.remove),
      this.addUsers(diffUsers.add),
    ];

    return Promise.all(requests);
  }
}

