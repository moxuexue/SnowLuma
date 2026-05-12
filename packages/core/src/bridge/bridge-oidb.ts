// OIDB protocol helpers -- encode requests, send+check, send+decode, UID resolution.

import type { Bridge } from './bridge';
import type { ProtoSchema } from '../protobuf/decode';
import { protoEncode, protoDecode } from '../protobuf/decode';
import { makeOidbBaseSchema } from './proto/oidb';

/**
 * Build a raw OIDB request buffer (base envelope wrapping a typed body).
 */
export function makeOidbRequest(
  command: number, subCommand: number,
  body: any, bodySchema: ProtoSchema, isUid = false,
): Uint8Array {
  const baseSchema = makeOidbBaseSchema(bodySchema);
  return protoEncode({
    command,
    subCommand,
    errorCode: 0,
    body,
    errorMsg: '',
    reserved: isUid ? 1 : 0,
  }, baseSchema);
}

/**
 * Send an OIDB packet and verify it succeeded (no decode of body).
 */
export async function sendOidbAndCheck(
  bridge: Bridge,
  serviceCmd: string, command: number, subCommand: number,
  body: any, bodySchema: ProtoSchema, isUid = false,
): Promise<void> {
  const request = makeOidbRequest(command, subCommand, body, bodySchema, isUid);
  const result = await bridge.sendRawPacket(serviceCmd, request);
  if (!result.success) throw new Error(result.errorMessage || 'packet send failed');
  if (!result.gotResponse) throw new Error(result.errorMessage || 'no response');
  // Check OIDB error code if response present
  if (result.responseData && result.responseData.length > 0) {
    const emptyBase = makeOidbBaseSchema({ _dummy: { field: 99, type: 'uint32' as const } });
    const resp = protoDecode(result.responseData, emptyBase);
    if (resp && (resp as any).errorCode && (resp as any).errorCode !== 0) {
      throw new Error(`OIDB error ${(resp as any).errorCode}: ${(resp as any).errorMsg ?? ''}`);
    }
  }
}

/**
 * Send an OIDB packet and decode the response body with the given schema.
 */
export async function sendOidbAndDecode<T>(
  bridge: Bridge,
  serviceCmd: string, command: number, subCommand: number,
  body: any, bodySchema: ProtoSchema, responseSchema: ProtoSchema, isUid = false,
): Promise<T> {
  const request = makeOidbRequest(command, subCommand, body, bodySchema, isUid);
  const result = await bridge.sendRawPacket(serviceCmd, request);
  if (!result.success) throw new Error(result.errorMessage || 'packet send failed');
  if (!result.gotResponse || !result.responseData) throw new Error(result.errorMessage || 'no response');

  const baseSchema = makeOidbBaseSchema(responseSchema);
  const resp = protoDecode(result.responseData, baseSchema);
  if (!resp) throw new Error('failed to decode OIDB response');
  if ((resp as any).errorCode && (resp as any).errorCode !== 0) {
    throw new Error(`OIDB error ${(resp as any).errorCode}: ${(resp as any).errorMsg ?? ''}`);
  }
  return (resp as any).body as T;
}

/**
 * Resolve a UIN to a UID string, using cache or fetching as needed.
 * Mirrors C++ resolve_user_uid_for_action.
 */
export async function resolveUserUid(bridge: Bridge, uin: number, groupId?: number): Promise<string> {
  // Try group member first
  if (groupId !== undefined) {
    const uid = bridge.identity.findUidByUin(uin, groupId);
    if (uid) return uid;
    // Try fetching member list
    try { await bridge.fetchGroupMemberList(groupId); } catch { /* ignore */ }
    const uid2 = bridge.identity.findUidByUin(uin, groupId);
    if (uid2) return uid2;
  }
  // Try cached
  const uid = bridge.identity.findUidByUin(uin);
  if (uid) return uid;
  // Fetch profile
  const profile = await bridge.fetchUserProfile(uin);
  if (profile.uid) return profile.uid;
  throw new Error(`failed to resolve UID for UIN ${uin}`);
}
