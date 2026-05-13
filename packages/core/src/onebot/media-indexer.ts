// Side-channel observer that watches every image / record / video
// segment emitted by the event converter and writes a row into the
// MediaStore so later `get_image` / `get_record` OneBot actions can
// resolve the original `data.file` back to a URL + metadata.
//
// Used as the `mediaSegmentSink` callback in `ConverterContext`.
//
// The fan-out is uniform (always one rememberX call per segment), but
// each mediaType maps to a slightly different MediaStore record shape;
// keeping the three field maps in one place makes the divergence
// visible at a glance.

import type { MessageElement } from '../bridge/events';
import type { JsonObject } from './types';
import type { MediaStore } from './media-store';

export type MediaType = 'image' | 'record' | 'video';

export class MediaIndexer {
  constructor(private readonly mediaStore: MediaStore) {}

  remember(
    mediaType: MediaType,
    element: MessageElement,
    data: JsonObject,
    isGroup: boolean,
    sessionId: number,
  ): void {
    const url = typeof data.url === 'string' ? data.url : '';
    const file = typeof data.file === 'string' ? data.file : '';

    if (mediaType === 'image') {
      this.mediaStore.rememberImage({
        file: file || element.fileId || '',
        url,
        fileSize: element.fileSize ?? 0,
        fileName: element.fileId ?? '',
        subType: element.subType ?? 0,
        summary: element.summary ?? '',
        imageUrl: element.imageUrl ?? '',
        isGroup,
        sessionId,
        md5Hex: element.md5Hex,
        sha1Hex: element.sha1Hex,
        width: element.width,
        height: element.height,
        picFormat: element.picFormat,
      });
      return;
    }

    if (mediaType === 'record') {
      this.mediaStore.rememberRecord({
        file: file || element.fileName || element.fileId || '',
        fileId: element.fileId ?? '',
        url,
        fileSize: element.fileSize ?? 0,
        fileName: element.fileName ?? '',
        duration: element.duration ?? 0,
        fileHash: element.fileHash ?? '',
        mediaNode: element.mediaNode,
        isGroup,
        sessionId,
        md5Hex: element.md5Hex,
        sha1Hex: element.sha1Hex,
        voiceFormat: element.voiceFormat,
      });
      return;
    }

    // video
    this.mediaStore.rememberVideo({
      file: file || element.fileName || element.fileId || '',
      fileId: element.fileId ?? '',
      url,
      fileSize: element.fileSize ?? 0,
      fileName: element.fileName ?? '',
      duration: element.duration ?? 0,
      fileHash: element.fileHash ?? '',
      mediaNode: element.mediaNode,
      isGroup,
      sessionId,
      md5Hex: element.md5Hex,
      sha1Hex: element.sha1Hex,
      width: element.width,
      height: element.height,
      videoFormat: element.videoFormat,
    });
  }
}
