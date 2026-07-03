/**
 * PTY Backend 选择器
 */

import { PtyBackend } from "../types";
import { NodePtyBackend, isNodePtyAvailable } from "./node-pty-backend";
import { log } from "../utils/logger";

export async function createPtyBackend(): Promise<PtyBackend | null> {
  // 使用 node-pty
  if (isNodePtyAvailable()) {
    log({ logFile: undefined, message: "[pty] 使用 node-pty 后端" });
    return new NodePtyBackend();
  }

  log({ logFile: undefined, message: "[pty] node-pty 未安装，请运行 npm install node-pty", level: 'error' });
  return null;
}