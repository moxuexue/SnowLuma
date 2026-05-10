import type { JsonArray, JsonObject } from './json';

export interface SendMessageResult {
  message_id: number;
}

export interface ForwardMessageResult {
  message_id: number;
  res_id: string;
  forward_id: string;
}

export interface UploadForwardResult {
  message_id: number;
  res_id: string;
  forward_id: string;
  group_id?: number;
}

export interface LoginInfo {
  user_id: number;
  nickname: string;
}

export interface StatusInfo {
  online: boolean;
  good: boolean;
}

export interface VersionInfo {
  app_name: string;
  app_version: string;
  protocol_version: string;
}

export interface CapabilityInfo {
  yes: boolean;
}

export interface GroupFileUrl {
  url: string;
}

export interface PrivateFileUrl {
  url: string;
}

export interface GroupFileSystemInfo {
  file_count: number;
  limit_count: number;
  used_space: number;
  total_space: number;
}

export interface GroupMessageHistory {
  messages: JsonObject[];
}

export interface FriendMessageHistory {
  messages: JsonObject[];
}

export interface MediaInfo extends JsonObject {}

export interface CookieInfo {
  cookies: string;
}

export interface CsrfInfo {
  token: number;
}

export interface CredentialsInfo {
  cookies: string;
  token: number;
  csrf_token: number;
}

export interface DownloadFileResult {
  file: string;
}

export interface ClientKeyInfo {
  clientKey: string;
  keyIndex: string;
  expireTime: string;
}

export interface OnlineClientsInfo {
  clients: JsonArray;
}

export interface UrlSafetyInfo {
  level: number;
}

export interface GroupAtAllRemainInfo {
  can_at_all: boolean;
  remain_at_all_count_for_group: number;
  remain_at_all_count_for_uin: number;
}

export type EmptyData = null;
