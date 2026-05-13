export interface PacketInfo {
  pid: number;
  uin: string;
  packetType?: number;
  serviceCmd: string;
  seqId: number;
  retCode: number;
  fromClient: boolean;
  body: Uint8Array;
}

/**
 * Packet sink injected into HookSession / HookManager. The default
 * wiring forwards to BridgeManager.onPacket, but tests inject spies.
 */
export type PacketSink = (packet: PacketInfo) => void;
