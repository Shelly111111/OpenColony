/**
 * PTY Backend 选择器
 */

import { PtyBackend } from "../types";
import { NodePtyBackend, isNodePtyAvailable } from "./node-pty-backend";

export async function createPtyBackend(): Promise<PtyBackend | null> {
  // 使用 node-pty
  if (isNodePtyAvailable()) {
    console.log("[pty] 使用 node-pty 后端");
    return new NodePtyBackend();
  }

  console.error("[pty] node-pty 未安装，请运行 npm install node-pty");
  return null;
}