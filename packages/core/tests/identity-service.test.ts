import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { IdentityService } from '../src/bridge/identity-service';
import { QQInfo, type GroupMemberInfo, type QQGroupInfo } from '../src/bridge/qq-info';

const SELF_UIN = '10001';
const GROUP_ID = 123456789;

const dbs: string[] = [];

function tempDbPath(label: string): string {
  const dbPath = path.join(
    'data',
    'test',
    `snowluma-identity-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  dbs.push(dbPath);
  return dbPath;
}

function cleanupDb(dbPath: string): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
}

function makeGroup(): QQGroupInfo {
  return {
    groupId: GROUP_ID,
    groupName: 'group',
    remark: '',
    memberCount: 0,
    memberMax: 500,
    members: new Map(),
  };
}

function makeMember(uin: number, uid: string, card = ''): GroupMemberInfo {
  return {
    uin,
    uid,
    nickname: `nick-${uin}`,
    card,
    role: 'member',
    level: 1,
    title: '',
    joinTime: 10,
    lastSentTime: 20,
    shutUpTime: 0,
  };
}

afterEach(() => {
  for (const dbPath of dbs.splice(0)) cleanupDb(dbPath);
});

describe('IdentityService', () => {
  it('persists friends, groups, and active group members', () => {
    const dbPath = tempDbPath('persist');

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);
      identity.rememberFriends([{ uin: 22222, uid: 'u_friend', nickname: 'friend', remark: 'remark' }]);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [makeMember(33333, 'u_member', 'card')]);
      identity.close();
    }

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);

      expect(qqInfo.findFriend(22222)?.uid).toBe('u_friend');
      expect(qqInfo.findGroup(GROUP_ID)?.groupName).toBe('group');
      expect(qqInfo.findGroupMember(GROUP_ID, 33333)?.card).toBe('card');
      expect(identity.findUidByUin(33333, GROUP_ID)).toBe('u_member');
      expect(identity.findUinByUid('u_member', GROUP_ID)).toBe(33333);

      identity.close();
    }
  });

  it('marks missing members inactive only after a successful full refresh', () => {
    const dbPath = tempDbPath('inactive-refresh');
    const first = makeMember(33333, 'u_first');
    const second = makeMember(44444, 'u_second');

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [first, second]);
      identity.rememberGroupMembers(GROUP_ID, [second]);
      identity.close();
    }

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);

      expect(qqInfo.findGroupMember(GROUP_ID, first.uin)).toBeNull();
      expect(qqInfo.findGroupMember(GROUP_ID, second.uin)?.uid).toBe(second.uid);
      // Historical identity remains available for UID/UIN resolution.
      expect(identity.findUidByUin(first.uin, GROUP_ID)).toBe(first.uid);

      identity.close();
    }
  });

  it('marks missing friends and groups inactive after successful full refreshes', () => {
    const dbPath = tempDbPath('inactive-lists');
    const member = makeMember(33333, 'u_member');

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);
      identity.rememberFriends([{ uin: 22222, uid: 'u_friend', nickname: 'friend', remark: '' }]);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [member]);
      identity.rememberFriends([]);
      identity.rememberGroups([]);
      identity.close();
    }

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);

      expect(qqInfo.findFriend(22222)).toBeNull();
      expect(qqInfo.findGroup(GROUP_ID)).toBeNull();
      // Identity mappings remain useful for historical events/actions.
      expect(identity.findUidByUin(22222)).toBe('u_friend');
      expect(identity.findUidByUin(member.uin, GROUP_ID)).toBe(member.uid);

      identity.close();
    }
  });

  it('can mark one member inactive without losing the identity mapping', () => {
    const dbPath = tempDbPath('inactive-event');
    const member = makeMember(33333, 'u_member');

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [member]);
      identity.markGroupMemberInactive(GROUP_ID, { uid: member.uid, uin: member.uin });
      identity.close();
    }

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);

      expect(qqInfo.findGroupMember(GROUP_ID, member.uin)).toBeNull();
      expect(identity.findUinByUid(member.uid, GROUP_ID)).toBe(member.uin);

      identity.close();
    }
  });

  it('persists identities learned from request events', () => {
    const dbPath = tempDbPath('request-events');

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);
      identity.rememberRequestIdentity({
        uid: 'u_friend_request',
        uin: 55555,
        source: 'friend_request',
      });
      identity.rememberRequestIdentity({
        groupId: GROUP_ID,
        uid: 'u_group_request',
        uin: 66666,
        source: 'group_request',
      });
      identity.close();
    }

    {
      const qqInfo = new QQInfo(SELF_UIN);
      const identity = new IdentityService(qqInfo, dbPath);

      expect(identity.findUidByUin(55555)).toBe('u_friend_request');
      expect(identity.findUinByUid('u_friend_request')).toBe(55555);
      expect(qqInfo.findGroup(GROUP_ID)?.groupId).toBe(GROUP_ID);
      expect(identity.findUidByUin(66666)).toBe('u_group_request');

      identity.close();
    }
  });
});
