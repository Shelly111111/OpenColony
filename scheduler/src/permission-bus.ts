/**
 * 权限审批事件总线
 * 替代 globalThis.__resolvePermission 的跨模块通信方案
 * sdk-client.ts 发出权限请求后等待审批，index.ts 收到 stdin 审批响应通过此总线传递
 */

import { EventEmitter } from "events";

const permissionBus = new EventEmitter();

// 确保不会因 listener 泄漏导致警告（每个 Worker 实例只会有一个 pending resolver）
permissionBus.setMaxListeners(20);

export { permissionBus };
