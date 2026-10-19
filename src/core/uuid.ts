// 不用全局加密 API：LAN http 环境下浏览器缺失，上游生态已踩坑。
// 记忆库 id 不是安全令牌，Math.random 的随机性足够防撞。
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
