// Video upload pipeline:
//   1. resolve / fetch the source video and optional thumbnail,
//   2. generate a thumbnail via ffmpegAddon when needed,
//   3. NTV2 OIDB upload request - 0x11EA (group) / 0x11E9 (private),
//   4. highway HTTP upload for video + thumbnail,
//   5. return the encoded `MsgInfo` bytes ready for the commonElem.
//
// Port of NapCat's UploadGroupVideo / UploadPrivateVideo transformers and
// the uploadGroupVideo / uploadC2CVideo paths in PacketHighwayContext.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import type { Bridge } from '../bridge';
import type { MessageElement } from '../events';
import { protoEncode, protoDecode } from '../../protobuf/decode';
import { makeOidbBaseSchema } from '../proto/oidb';
import {
  NTV2UploadRichMediaReqSchema,
  NTV2UploadRichMediaRespSchema,
  EncodableMediaMsgInfoSchema,
} from '../proto/highway';
import {
  loadBinarySource,
  computeHashes,
  detectImageFormat,
} from './utils';
import {
  fetchHighwaySession,
  uploadHighwayHttp,
  buildHighwayExtend,
} from './highway-client';
import { getFFmpegAddon } from './ffmpeg-addon';
import { createLogger } from '../../utils/logger';

const log = createLogger('Video');

export const PRIVATE_VIDEO_CMD_ID = 1001;
export const PRIVATE_VIDEO_THUMB_CMD_ID = 1002;
export const GROUP_VIDEO_CMD_ID = 1005;
export const GROUP_VIDEO_THUMB_CMD_ID = 1006;

const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const SHA1_STREAM_BLOCK_SIZE = 1024 * 1024;

const FALLBACK_THUMB = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

interface VideoPayload {
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  sha1Blocks: Uint8Array[];
  md5Hex: string;
  sha1Hex: string;
  fileName: string;
  filePath: string;
  width: number;
  height: number;
  duration: number;
  thumb: ThumbPayload;
  cleanups: Array<() => void>;
}

interface ThumbPayload {
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  width: number;
  height: number;
}

class Sha1StreamState {
  readonly blockSize = 64;
  private readonly padding = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(63)]);
  private readonly state = new Uint32Array(5);
  private readonly count = new Uint32Array(2);
  private readonly buffer = Buffer.allocUnsafe(this.blockSize);
  private readonly w = new Uint32Array(80);

  constructor() {
    this.reset();
  }

  private reset(): void {
    this.state[0] = 0x67452301;
    this.state[1] = 0xEFCDAB89;
    this.state[2] = 0x98BADCFE;
    this.state[3] = 0x10325476;
    this.state[4] = 0xC3D2E1F0;
    this.count[0] = 0;
    this.count[1] = 0;
    this.buffer.fill(0);
  }

  private rotateLeft(value: number, offset: number): number {
    return ((value << offset) | (value >>> (32 - offset))) >>> 0;
  }

  private transform(chunk: Uint8Array, offset: number): void {
    const view = new DataView(chunk.buffer, chunk.byteOffset + offset, this.blockSize);

    for (let i = 0; i < 16; i++) {
      this.w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      this.w[i] = this.rotateLeft(this.w[i - 3] ^ this.w[i - 8] ^ this.w[i - 14] ^ this.w[i - 16], 1);
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];

    for (let i = 0; i < 80; i++) {
      let temp: number;
      if (i < 20) {
        temp = ((b & c) | (~b & d)) + 0x5A827999;
      } else if (i < 40) {
        temp = (b ^ c ^ d) + 0x6ED9EBA1;
      } else if (i < 60) {
        temp = ((b & c) | (b & d) | (c & d)) + 0x8F1BBCDC;
      } else {
        temp = (b ^ c ^ d) + 0xCA62C1D6;
      }
      temp += (this.rotateLeft(a, 5) + e + this.w[i]) >>> 0;
      e = d;
      d = c;
      c = this.rotateLeft(b, 30);
      b = a;
      a = temp >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
  }

  update(data: Uint8Array): void {
    let index = (this.count[0] >>> 3) & 0x3F;
    const dataLen = data.length;
    this.count[0] = (this.count[0] + (dataLen << 3)) >>> 0;
    if (this.count[0] < (dataLen << 3)) this.count[1] = (this.count[1] + 1) >>> 0;
    this.count[1] = (this.count[1] + (dataLen >>> 29)) >>> 0;

    const partLen = this.blockSize - index;
    let i = 0;

    if (dataLen >= partLen) {
      this.buffer.set(data.subarray(0, partLen), index);
      this.transform(this.buffer, 0);
      for (i = partLen; i + this.blockSize <= dataLen; i += this.blockSize) {
        this.transform(data, i);
      }
      index = 0;
    }

    if (i < dataLen) {
      this.buffer.set(data.subarray(i, dataLen), index);
    }
  }

  hash(bigEndian = true): Uint8Array {
    const digest = Buffer.allocUnsafe(20);
    for (let i = 0; i < 5; i++) {
      if (bigEndian) digest.writeUInt32BE(this.state[i], i * 4);
      else digest.writeUInt32LE(this.state[i], i * 4);
    }
    return new Uint8Array(digest);
  }

  final(): Uint8Array {
    const bits = Buffer.allocUnsafe(8);
    bits.writeUInt32BE(this.count[1], 0);
    bits.writeUInt32BE(this.count[0], 4);

    const index = (this.count[0] >>> 3) & 0x3F;
    const padLen = index < 56 ? 56 - index : 120 - index;
    this.update(this.padding.subarray(0, padLen));
    this.update(bits);
    return this.hash(true);
  }
}

function computeVideoSha1Blocks(bytes: Uint8Array): Uint8Array[] {
  const sha1 = new Sha1StreamState();
  const blocks: Uint8Array[] = [];
  let bytesRead = 0;
  let offset = 0;

  while (offset + sha1.blockSize <= bytes.length) {
    const block = bytes.subarray(offset, offset + sha1.blockSize);
    sha1.update(block);
    offset += sha1.blockSize;
    bytesRead += sha1.blockSize;
    if (bytesRead % SHA1_STREAM_BLOCK_SIZE === 0) {
      blocks.push(sha1.hash(false));
    }
  }

  if (offset < bytes.length) sha1.update(bytes.subarray(offset));
  blocks.push(sha1.final());
  return blocks;
}

function asLocalFilePath(source: string): string | null {
  if (!source) return null;
  if (source.startsWith('base64://')) return null;
  if (source.startsWith('http://') || source.startsWith('https://')) return null;

  let filePath = source;
  if (filePath.startsWith('file://')) filePath = filePath.slice(7);
  if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);

  return filePath;
}

function defaultVideoTempDir(): string {
  return path.join(os.tmpdir(), 'snowluma-video');
}

function sourceExtension(fileName: string, source: string): string {
  const fromName = path.extname(fileName);
  if (fromName) return fromName;

  const local = asLocalFilePath(source);
  const fromSource = local ? path.extname(local) : '';
  return fromSource || '.mp4';
}

function makeClientRandomId(): bigint {
  const buf = crypto.randomBytes(8);
  return buf.readBigUInt64BE() & 0x7FFFFFFFFFFFFFFFn;
}

async function stageVideoSource(element: MessageElement, tempDir: string, cleanups: Array<() => void>): Promise<{
  bytes: Uint8Array;
  filePath: string;
  fileName: string;
}> {
  const source = element.url || element.fileId || '';
  if (!source) throw new Error('video source is empty');

  const local = asLocalFilePath(source);
  if (local && fs.existsSync(local)) {
    return {
      bytes: new Uint8Array(fs.readFileSync(local)),
      filePath: local,
      fileName: element.fileName || path.basename(local),
    };
  }

  const loaded = await loadBinarySource(source, 'video');
  const fileName = element.fileName || loaded.fileName || '';
  const stagedPath = path.join(tempDir, `snowluma-video-in-${crypto.randomUUID()}${sourceExtension(fileName, source)}`);
  fs.writeFileSync(stagedPath, Buffer.from(loaded.bytes));
  cleanups.push(() => { try { fs.unlinkSync(stagedPath); } catch { /* ignore */ } });

  return {
    bytes: loaded.bytes,
    filePath: stagedPath,
    fileName,
  };
}

async function loadThumb(element: MessageElement, videoPath: string): Promise<{
  thumb: ThumbPayload;
  width: number;
  height: number;
  duration: number;
}> {
  let width = element.width ?? 0;
  let height = element.height ?? 0;
  let duration = element.duration ?? 0;
  let thumbBytes: Uint8Array | null = null;

  if (element.thumbUrl) {
    try {
      thumbBytes = (await loadBinarySource(element.thumbUrl, 'video thumbnail')).bytes;
    } catch (err) {
      log.warn('custom video thumbnail load failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  if (!thumbBytes) {
    try {
      const info = await getFFmpegAddon().getVideoInfo(videoPath);
      width = width || info.width || 0;
      height = height || info.height || 0;
      duration = duration || Math.max(1, Math.round(info.duration || 0));
      if (info.image && info.image.length > 0) {
        thumbBytes = new Uint8Array(info.image);
      }
    } catch (err) {
      log.warn('video thumbnail generation failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  if (!thumbBytes) {
    thumbBytes = new Uint8Array(FALLBACK_THUMB);
  }

  const fmt = detectImageFormat(thumbBytes);
  width = width || fmt.width || 1;
  height = height || fmt.height || 1;
  duration = duration || 1;

  const hashes = computeHashes(thumbBytes);
  return {
    width,
    height,
    duration,
    thumb: {
      bytes: thumbBytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      width,
      height,
    },
  };
}

async function loadVideo(element: MessageElement): Promise<VideoPayload> {
  const tempDir = defaultVideoTempDir();
  const cleanups: Array<() => void> = [];
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const staged = await stageVideoSource(element, tempDir, cleanups);
    if (staged.bytes.length === 0) throw new Error('video file is empty');
    if (staged.bytes.length > MAX_VIDEO_SIZE) {
      throw new Error(`video file too large: ${(staged.bytes.length / (1024 * 1024)).toFixed(2)} MB > 100 MB`);
    }

    const hashes = computeHashes(staged.bytes);
    const { thumb, width, height, duration } = await loadThumb(element, staged.filePath);

    return {
      bytes: staged.bytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      sha1Blocks: computeVideoSha1Blocks(staged.bytes),
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      fileName: staged.fileName || `${hashes.md5Hex}.mp4`,
      filePath: staged.filePath,
      width,
      height,
      duration,
      thumb,
      cleanups: [...cleanups],
    };
  } catch (err) {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
    throw err;
  }
}

async function startVideoUpload(
  bridge: Bridge,
  isGroup: boolean,
  targetIdOrUid: string | number,
  video: VideoPayload,
): Promise<any> {
  const body: any = {
    reqHead: {
      common: { requestId: 3, command: 100 },
      scene: {
        requestType: 2,
        businessType: 2,
        sceneType: isGroup ? 2 : 1,
        ...(isGroup
          ? { group: { groupUin: Number(targetIdOrUid) } }
          : { c2c: { accountType: 2, targetUid: String(targetIdOrUid) } }),
      },
      client: { agentType: 2 },
    },
    upload: {
      uploadInfo: [
        {
          fileInfo: {
            fileSize: video.bytes.length,
            fileHash: video.md5Hex,
            fileSha1: video.sha1Hex,
            fileName: 'nya.mp4',
            type: { type: 2, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
            height: 0,
            width: 0,
            time: 0,
            original: 0,
          },
          subFileType: 0,
        },
        {
          fileInfo: {
            fileSize: video.thumb.bytes.length,
            fileHash: video.thumb.md5Hex,
            fileSha1: video.thumb.sha1Hex,
            fileName: 'nya.jpg',
            type: { type: 1, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
            height: video.thumb.height,
            width: video.thumb.width,
            time: 0,
            original: 0,
          },
          subFileType: 100,
        },
      ],
      tryFastUploadCompleted: true,
      srvSendMsg: false,
      clientRandomId: makeClientRandomId(),
      compatQmsgSceneType: 2,
      extBizInfo: {
        pic: { bizType: 0, textSummary: 'Nya~' },
        video: { bytesPbReserve: new Uint8Array([0x80, 0x01, 0x00]) },
        ptt: {
          bytesPbReserve: new Uint8Array(0),
          bytesReserve: new Uint8Array(0),
          bytesGeneralFlags: new Uint8Array(0),
        },
      },
      clientSeq: 0,
      noNeedCompatMsg: false,
    },
  };

  const oidbCmd = isGroup ? 0x11EA : 0x11E9;
  const serviceCmd = isGroup ? 'OidbSvcTrpcTcp.0x11ea_100' : 'OidbSvcTrpcTcp.0x11e9_100';

  const baseSchema = makeOidbBaseSchema(NTV2UploadRichMediaReqSchema);
  const request = protoEncode({
    command: oidbCmd, subCommand: 100, errorCode: 0, body, errorMsg: '', reserved: 1,
  }, baseSchema);

  const result = await bridge.sendRawPacket(serviceCmd, request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'video upload request failed');
  }

  const respBaseSchema = makeOidbBaseSchema(NTV2UploadRichMediaRespSchema);
  const resp: any = protoDecode(result.responseData, respBaseSchema);
  if (!resp) throw new Error('failed to decode video upload response');
  if (resp.errorCode && resp.errorCode !== 0) {
    throw new Error(`OIDB error ${resp.errorCode}: ${resp.errorMsg ?? ''}`);
  }

  const uploadBody = resp.body;
  if (!uploadBody) throw new Error('video upload response body missing');
  if (uploadBody.respHead?.retCode && uploadBody.respHead.retCode !== 0) {
    throw new Error(uploadBody.respHead.message ?? 'video upload failed');
  }
  return uploadBody.upload;
}

function finalizeVideoMsgInfo(upload: any): Uint8Array {
  if (!upload?.msgInfo) throw new Error('video upload response missing msgInfo');

  const msgInfoBody = (upload.msgInfo.msgInfoBody ?? []).map((b: any) => ({
    index: b.index, picture: b.picture, fileExist: b.fileExist, hashSum: b.hashSum,
  }));

  const extBizInfo: any = {};
  if (upload.msgInfo.extBizInfo?.pic) extBizInfo.pic = upload.msgInfo.extBizInfo.pic;
  if (upload.msgInfo.extBizInfo?.video) extBizInfo.video = upload.msgInfo.extBizInfo.video;
  if (upload.msgInfo.extBizInfo?.ptt) extBizInfo.ptt = upload.msgInfo.extBizInfo.ptt;
  if (upload.msgInfo.extBizInfo?.busiType !== undefined) {
    extBizInfo.busiType = upload.msgInfo.extBizInfo.busiType;
  }

  return protoEncode({ msgInfoBody, extBizInfo }, EncodableMediaMsgInfoSchema);
}

/**
 * Upload a video and return the encoded `MsgInfo` bytes that go inside
 * a `commonElem { serviceType: 48, businessType: 21 }`.
 */
export async function uploadVideoMsgInfo(
  bridge: Bridge,
  isGroup: boolean,
  targetIdOrUid: string | number,
  element: MessageElement,
): Promise<Uint8Array> {
  const video = await loadVideo(element);
  try {
    const upload = await startVideoUpload(bridge, isGroup, targetIdOrUid, video);
    let session: Awaited<ReturnType<typeof fetchHighwaySession>> | null = null;
    const getSession = async () => {
      session ??= await fetchHighwaySession(bridge);
      return session;
    };

    const uKey = upload?.uKey ?? '';
    if (uKey && upload?.msgInfo) {
      log.debug('highway video upload: bytes=%d md5=%s scene=%s', video.bytes.length, video.md5Hex, isGroup ? 'group' : 'c2c');
      const extend = buildHighwayExtend(uKey, upload.msgInfo, upload.ipv4s ?? [], video.sha1Blocks, 0);
      const commandId = isGroup ? GROUP_VIDEO_CMD_ID : PRIVATE_VIDEO_CMD_ID;
      await uploadHighwayHttp(bridge, await getSession(), commandId, video.bytes, video.md5, extend);
    } else {
      log.debug('video fast-uploaded (server already has md5=%s)', video.md5Hex);
    }

    const subFile = upload?.subFileInfos?.[0];
    if (subFile?.uKey && upload?.msgInfo) {
      log.debug('highway video thumb upload: bytes=%d md5=%s scene=%s', video.thumb.bytes.length, video.thumb.md5Hex, isGroup ? 'group' : 'c2c');
      const extend = buildHighwayExtend(subFile.uKey, upload.msgInfo, subFile.ipv4s ?? [], video.thumb.sha1, 1);
      const commandId = isGroup ? GROUP_VIDEO_THUMB_CMD_ID : PRIVATE_VIDEO_THUMB_CMD_ID;
      await uploadHighwayHttp(bridge, await getSession(), commandId, video.thumb.bytes, video.thumb.md5, extend);
    } else {
      log.debug('video thumb fast-uploaded (server already has md5=%s)', video.thumb.md5Hex);
    }

    return finalizeVideoMsgInfo(upload);
  } finally {
    for (const fn of video.cleanups) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
  }
}
