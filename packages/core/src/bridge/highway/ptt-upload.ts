// Voice (PTT) upload pipeline:
//   1. resolve / fetch the source audio bytes,
//   2. convert to NT SILK via the ffmpegAddon (skip if already silk),
//   3. NTV2 OIDB upload request — 0x126E (group) / 0x126D (private),
//   4. highway HTTP upload — commandId 1008 (group) / 1007 (private),
//   5. return the encoded `MsgInfo` bytes ready for the commonElem.
//
// Port of NapCat's `UploadGroupPtt` / `UploadPrivatePtt` transformer + the
// `uploadGroupPtt` / `uploadC2CPtt` paths in `PacketHighwayContext`.

import fs from 'fs';
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
import { loadBinarySource, computeHashes } from './utils';
import {
  fetchHighwaySession,
  uploadHighwayHttp,
  buildHighwayExtend,
} from './highway-client';
import { encodeSilk, defaultPttTempDir } from './ffmpeg-addon';
import { createLogger } from '../../utils/logger';

const log = createLogger('Ptt');

export const PRIVATE_PTT_CMD_ID = 1007;
export const GROUP_PTT_CMD_ID = 1008;

interface PttPayload {
  /** Silk bytes that get uploaded to highway. */
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  fileName: string;
  /** Whole seconds, >= 1. */
  duration: number;
  /** Cleanup hooks invoked once the OIDB request + highway upload finish. */
  cleanups: Array<() => void>;
}

/**
 * Decide whether `source` looks like a local filesystem path. The shape
 * matches the heuristics used inside `loadBinarySource`: we only reuse the
 * caller-supplied path verbatim for things the addon can read directly.
 */
function asLocalFilePath(source: string): string | null {
  if (!source) return null;
  if (source.startsWith('base64://')) return null;
  if (source.startsWith('http://') || source.startsWith('https://')) return null;

  let filePath = source;
  if (filePath.startsWith('file://')) filePath = filePath.slice(7);
  if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);

  return filePath;
}

async function loadPtt(element: MessageElement, tempDir: string): Promise<PttPayload> {
  const source = element.url || element.fileId || '';
  if (!source) throw new Error('record source is empty');

  const cleanups: Array<() => void> = [];
  // Run all queued cleanups; callable both on the success path (via the
  // returned `cleanups` array) and the failure path (try/catch below).
  const runCleanups = () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (!fn) continue;
      try { fn(); } catch { /* best-effort */ }
    }
  };

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Resolve the on-disk path the addon should read. Anything that isn't
    // already a local file (base64, HTTP) gets staged into the temp dir.
    let inputPath: string;
    const local = asLocalFilePath(source);
    if (local && fs.existsSync(local)) {
      inputPath = local;
    } else {
      const loaded = await loadBinarySource(source, 'record');
      inputPath = path.join(tempDir, `snowluma-ptt-in-${crypto.randomUUID()}`);
      fs.writeFileSync(inputPath, Buffer.from(loaded.bytes));
      cleanups.push(() => { try { fs.unlinkSync(inputPath); } catch { /* ignore */ } });
    }

    const silk = await encodeSilk(inputPath, tempDir);
    if (silk.converted) {
      cleanups.push(() => { try { fs.unlinkSync(silk.path); } catch { /* ignore */ } });
      log.debug('converted record to silk: %s -> %s (duration=%ds)', inputPath, silk.path, silk.duration);
    }

    const silkBytes = new Uint8Array(fs.readFileSync(silk.path));
    if (silkBytes.length === 0) throw new Error('silk file is empty after conversion');

    const hashes = computeHashes(silkBytes);
    return {
      bytes: silkBytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      fileName: `${hashes.md5Hex}.amr`,
      duration: silk.duration,
      cleanups: [...cleanups],
    };
  } catch (err) {
    runCleanups();
    throw err;
  }
}

function makeClientRandomId(): bigint {
  // Same trick NapCat uses: 8 random bytes, masked into the positive int64
  // range so it survives proto signed-int64 encoding without surprises.
  const buf = crypto.randomBytes(8);
  return buf.readBigUInt64BE() & 0x7FFFFFFFFFFFFFFFn;
}

async function startPttUpload(
  bridge: Bridge,
  isGroup: boolean,
  targetIdOrUid: string | number,
  ptt: PttPayload,
): Promise<any> {
  const body: any = {
    reqHead: {
      // NapCat uses requestId=1 for group / 4 for c2c. Mirror it.
      common: { requestId: isGroup ? 1 : 4, command: 100 },
      scene: {
        requestType: 2,
        businessType: 3,
        sceneType: isGroup ? 2 : 1,
        ...(isGroup
          ? { group: { groupUin: Number(targetIdOrUid) } }
          : { c2c: { accountType: 2, targetUid: String(targetIdOrUid) } }),
      },
      client: { agentType: 2 },
    },
    upload: {
      uploadInfo: [{
        fileInfo: {
          fileSize: ptt.bytes.length,
          fileHash: ptt.md5Hex,
          fileSha1: ptt.sha1Hex,
          fileName: ptt.fileName,
          // type=3 voice, voiceFormat=1 (silk).
          type: { type: 3, picFormat: 0, videoFormat: 0, voiceFormat: 1 },
          width: 0,
          height: 0,
          time: ptt.duration,
          original: 0,
        },
        subFileType: 0,
      }],
      tryFastUploadCompleted: true,
      srvSendMsg: false,
      clientRandomId: makeClientRandomId(),
      compatQmsgSceneType: isGroup ? 2 : 1,
      extBizInfo: {
        // NapCat fills in a placeholder textSummary so the legacy compat
        // QMsg path still has something to render. Mirror it.
        pic: { textSummary: 'Nya~' },
        video: { bytesPbReserve: new Uint8Array(0) },
        ptt: {
          bytesReserve: new Uint8Array([0x08, 0x00, 0x38, 0x00]),
          bytesPbReserve: new Uint8Array(0),
          // `bytesGeneralFlags` differs between group / c2c voice. Lifted
          // verbatim from NapCat (UploadGroupPtt.ts / UploadPrivatePtt.ts).
          bytesGeneralFlags: isGroup
            ? new Uint8Array([0x9a, 0x01, 0x07, 0xaa, 0x03, 0x04, 0x08, 0x08, 0x12, 0x00])
            : new Uint8Array([0x9a, 0x01, 0x0b, 0xaa, 0x03, 0x08, 0x08, 0x04, 0x12, 0x04, 0x00, 0x00, 0x00, 0x00]),
        },
      },
      clientSeq: 0,
      noNeedCompatMsg: false,
    },
  };

  const oidbCmd = isGroup ? 0x126E : 0x126D;
  const serviceCmd = isGroup ? 'OidbSvcTrpcTcp.0x126e_100' : 'OidbSvcTrpcTcp.0x126d_100';

  const baseSchema = makeOidbBaseSchema(NTV2UploadRichMediaReqSchema);
  const request = protoEncode({
    command: oidbCmd, subCommand: 100, errorCode: 0, body, errorMsg: '', reserved: 1,
  }, baseSchema);

  const result = await bridge.sendRawPacket(serviceCmd, request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'ptt upload request failed');
  }

  const respBaseSchema = makeOidbBaseSchema(NTV2UploadRichMediaRespSchema);
  const resp: any = protoDecode(result.responseData, respBaseSchema);
  if (!resp) throw new Error('failed to decode ptt upload response');
  if (resp.errorCode && resp.errorCode !== 0) {
    throw new Error(`OIDB error ${resp.errorCode}: ${resp.errorMsg ?? ''}`);
  }

  const uploadBody = resp.body;
  if (!uploadBody) throw new Error('ptt upload response body missing');
  if (uploadBody.respHead?.retCode && uploadBody.respHead.retCode !== 0) {
    throw new Error(uploadBody.respHead.message ?? 'ptt upload failed');
  }
  return uploadBody.upload;
}

function finalizePttMsgInfo(upload: any): Uint8Array {
  if (!upload?.msgInfo) throw new Error('ptt upload response missing msgInfo');

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
 * Upload a voice clip and return the encoded `MsgInfo` bytes that go inside
 * a `commonElem { serviceType: 48, businessType: 22 }`.
 */
export async function uploadPttMsgInfo(
  bridge: Bridge,
  isGroup: boolean,
  targetIdOrUid: string | number,
  element: MessageElement,
): Promise<Uint8Array> {
  const tempDir = defaultPttTempDir();
  const ptt = await loadPtt(element, tempDir);
  try {
    const upload = await startPttUpload(bridge, isGroup, targetIdOrUid, ptt);

    // Highway upload only happens when the server didn't fast-path the file
    // (uKey present == "we want the bytes"). Otherwise we just embed the
    // returned MsgInfo and trust the dedupe.
    const uKey = upload?.uKey ?? '';
    if (uKey && upload?.msgInfo) {
      log.debug('highway upload: bytes=%d md5=%s scene=%s', ptt.bytes.length, ptt.md5Hex, isGroup ? 'group' : 'c2c');
      const session = await fetchHighwaySession(bridge);
      const extend = buildHighwayExtend(uKey, upload.msgInfo, upload.ipv4s ?? [], ptt.sha1);
      const commandId = isGroup ? GROUP_PTT_CMD_ID : PRIVATE_PTT_CMD_ID;
      await uploadHighwayHttp(bridge, session, commandId, ptt.bytes, ptt.md5, extend);
    } else {
      log.debug('ptt fast-uploaded (server already has md5=%s)', ptt.md5Hex);
    }

    return finalizePttMsgInfo(upload);
  } finally {
    for (const fn of ptt.cleanups) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
  }
}
