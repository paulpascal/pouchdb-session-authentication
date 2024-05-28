require('chai').use(require('chai-as-promised'));
const PouchDb = require('pouchdb-core');
PouchDb.plugin(require('pouchdb-adapter-http'));
PouchDb.plugin(require('../../src/index'));

const { expect } = require('chai');
const uuid = require('uuid').v4;

const utils = require('./utils');
const { Headers } = require('pouchdb-fetch');
const authType = process.env.AUTH_TYPE || 'auth';

const getSession = async (auth) => {
  const url = new URL(`${utils.baseUrl}/_session`);
  url.username = auth.username;
  url.password = auth.password;

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  const body = JSON.stringify({ name: auth.username, password: auth.password});
  const response = await PouchDb.fetch(url.toString(), { method: 'POST', headers, body });

  const cookie = response?.headers?.get('set-cookie');
  const sessionCookieName = 'AuthSession';
  const matches = cookie.match( new RegExp(`${sessionCookieName}=(.*)`));
  if (!matches) {
    return;
  }

  const parts = matches[1].split(';').map(item => item.trim().split('='));
  return parts[0][0];
};

const getDb = async (dbName, auth, authType, skip_setup = true) => {
  if (authType === 'url') {
    const url = new URL(`${utils.baseUrl}/${dbName}`);
    url.username = auth.username;
    url.password = auth.password;
    return new PouchDb(url.toString(), { skip_setup });
  }

  if (authType === 'session') {
    const url = new URL(`${utils.baseUrl}/${dbName}`);
    const session = await getSession(auth);
    const db = new PouchDb(url.toString(), { skip_setup, session });
    await PouchDb.fetch(url.toString()); // overwrite last docker logs
    return db;
  }

  return new PouchDb(`${utils.baseUrl}/${dbName}`, { skip_setup, auth });
};


describe(`integration with ${authType}`, async function () {
  const dbName = 'testdb';
  let db;

  let tempDbName;
  let tempAdminName;
  let tempDb;

  this.timeout(12000);
  before(async () => {
    await utils.setupCouch(dbName);
    db = await getDb(dbName, utils.dbAuth, authType);
  });

  beforeEach(() => {
    tempDbName = `temp${uuid()}`;
    tempAdminName = `temp${uuid()}`;
  });

  afterEach(async () => {
    try {
      await tempDb?.destroy();
    } catch (err) {
      // will throw if db doesn't exist
    }

    await utils.deleteDb(tempDbName);
    await utils.deleteAdmin(tempAdminName);
  });

  describe('#nosession auth type', () => {
    it('should setup session on first request and reuse session on subsequent request', async () => {
      const collectLogs = await utils.getDockerContainerLogs();
      await db.allDocs();
      await db.allDocs();
      await db.allDocs();
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs).length).to.equal(1);
      expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.equal(3);
    });

    it('should reuse the same session for new databases', async () => {
      const collectLogs = await utils.getDockerContainerLogs();
      await db.allDocs();

      tempDb = await getDb(tempDbName, utils.dbAuth, authType);
      await utils.createDb(tempDbName);

      await tempDb.allDocs();

      const logs = await collectLogs();
      expect(utils.getSessionRequests(logs).length).to.equal(0);
      expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.be.least(2);
    });

    it('should create a new session for new users', async () => {
      const auth = { username: tempAdminName, password: 'spacesareaproblem' };
      await utils.createAdmin(auth.username, auth.password);
      await utils.createDb(tempDbName);

      tempDb = await getDb(tempDbName, auth, authType);

      const collectLogs = await utils.getDockerContainerLogs();
      await db.allDocs();
      await tempDb.allDocs();

      const logs = await collectLogs();

      expect(utils.getDbRequest(auth.username, logs, tempDbName, '/_all_docs').length).to.equal(1);
      expect(utils.getSessionRequests(logs).length).to.equal(1);
      expect(utils.getCookieAuthRequests(auth.username, logs).length).to.equal(1);
    });

    it('should throw errors on password changes', async () => {
      const auth = { username: tempAdminName, password: 'new_password' };
      await utils.createAdmin(auth.username, auth.password);
      await utils.createDb(tempDbName);

      tempDb = await getDb(tempDbName, auth, authType);

      const collectLogs = await utils.getDockerContainerLogs();
      await tempDb.allDocs();
      await utils.createAdmin(auth.username, 'password change');
      await expect(tempDb.allDocs()).to.eventually.be.rejectedWith('Name or password is incorrect.');
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs, false).length).to.equal(1);
      expect(utils.getDbRequest('undefined', logs, tempDbName, '/_all_docs', false).length).to.equal(2);
    });

    it('should throw errors on invalid credentials', async () => {
      const newDb = await getDb(dbName, { username: utils.dbAuth.username, password: 'wrong password' }, authType);

      const collectLogs = await utils.getDockerContainerLogs();
      await expect(newDb.allDocs()).to.eventually.be.rejectedWith('Name or password is incorrect.');
      const logs = await collectLogs();
      expect(utils.getSessionRequests(logs, false).length).to.equal(1);
    });

    it('should automatically refresh the cookie when closing to expiry', async () => {
      await utils.asyncTimeout(3000);
      await db.allDocs();
      await utils.asyncTimeout(3000);
      await db.allDocs();
    });

    it('should automatically refresh the cookie when expired', async () => {
      const collectLogs = await utils.getDockerContainerLogs();
      await utils.asyncTimeout(6000);
      await db.allDocs();
      const logs = await collectLogs(1000);
      expect(utils.getSessionRequests(logs).length).to.equal(1);
    });

    it('should support initial setup', async () => {
      const auth = { username: tempAdminName, password: 'new_password' };
      await utils.createAdmin(auth.username, auth.password);

      const collectLogs = await utils.getDockerContainerLogs();
      tempDb = await getDb(tempDbName, auth, authType, false);
      await tempDb.allDocs();
      const logs = await collectLogs(1000);
      expect(utils.getSessionRequests(logs).length).to.equal(1);
    });

    it('should only request session once for concurrent requests', async () => {
      const auth = { username: tempAdminName, password: 'new_password' };
      await utils.createAdmin(auth.username, auth.password);
      await utils.createDb(tempDbName);

      tempDb = await getDb(tempDbName, auth, authType);
      const collectLogs = await utils.getDockerContainerLogs();
      await Promise.all([
        tempDb.allDocs(),
        tempDb.allDocs(),
        tempDb.allDocs(),
        tempDb.allDocs(),
        tempDb.allDocs(),
      ]);

      const logs = await collectLogs();
      expect(utils.getSessionRequests(logs).length).to.equal(1);
    });
  });

  describe('#session auth type', () => {
    it('should use existent session when connecting to any DB', async () => {
      await utils.createDb(tempDbName);
      tempDb = await getDb(tempDbName, utils.dbAuth, authType);

      const collectLogs = await utils.getDockerContainerLogs();
      await db.allDocs();
      await db.allDocs();
      await db.allDocs();
      await tempDb.allDocs();
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs).length).to.equal(0);
      expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.equal(4);
    });

    it('should fail if session is not valid', async () => {
      await utils.createDb(tempDbName);

      const url = new URL(`${utils.baseUrl}/${dbName}`);
      tempDb = new PouchDb(url.toString(), { skip_setup: true, session: 'invalid' });

      const collectLogs = await utils.getDockerContainerLogs();
      await expect(tempDb.allDocs()).to.eventually.be.rejectedWith(
        'Malformed AuthSession cookie. Please clear your cookies.'
      );
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs).length).to.equal(0);
      expect(utils.getCookieAuthRequests(utils.dbAuth.username, logs).length).to.equal(0);
    });

    it('should fail if session is invalid due to password change', async () => {
      const auth = { username: tempAdminName, password: 'new_password' };
      await utils.createAdmin(auth.username, auth.password);
      await utils.createDb(tempDbName);

      tempDb = await getDb(tempDbName, auth, authType);

      const collectLogs = await utils.getDockerContainerLogs();
      await tempDb.allDocs();
      await utils.createAdmin(auth.username, 'password change');
      await expect(tempDb.allDocs()).to.eventually.be.rejectedWith('Authentication required.');
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs, false).length).to.equal(1);
      expect(utils.getDbRequest('undefined', logs, tempDbName, '/_all_docs', false).length).to.equal(2);
    });

    it('should try to get session again if credentials are provided but session is expired', async () => {
      const auth = { username: tempAdminName, password: 'new_password' };
      await utils.createAdmin(auth.username, auth.password);
      await utils.createDb(tempDbName);

      const session = await getSession(auth);
      const url = new URL(`${utils.baseUrl}/${tempDbName}`);
      tempDb = new PouchDb(url.toString(), { skip_setup: true, session, auth: utils.dbAuth });
      await PouchDb.fetch(url.toString()); // overwrite last docker logs

      const collectLogs = await utils.getDockerContainerLogs();
      await tempDb.allDocs();
      await utils.createAdmin(auth.username, 'password update');
      await tempDb.allDocs();
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs, false).length).to.equal(0);
      expect(utils.getDbRequest(utils.dbAuth.username, logs, tempDbName, '/_all_docs', true).length).to.equal(1);
      expect(utils.getDbRequest(auth.username, logs, tempDbName, '/_all_docs', true).length).to.equal(1);
    });

    it('should fail if neither session or auth works', async () => {
      const auth = { username: tempAdminName, password: 'new_password' };
      await utils.createAdmin(auth.username, auth.password);
      await utils.createDb(tempDbName);

      const session = await getSession(auth);
      const url = new URL(`${utils.baseUrl}/${tempDbName}`);
      tempDb = new PouchDb(url.toString(), { skip_setup: true, session, auth});
      await utils.createAdmin(auth.username, 'password update');

      const collectLogs = await utils.getDockerContainerLogs();
      await expect(tempDb.allDocs()).to.eventually.be.rejectedWith('Name or password is incorrect.');
      const logs = await collectLogs();

      expect(utils.getSessionRequests(logs, false).length).to.equal(1);
    });
  });
});

