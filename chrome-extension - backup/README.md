# 多网站自动签到助手 - Chrome 扩展

基于 linux.do OAuth2.0 授权的多网站自动签到工具（浏览器扩展版）

## 功能特点

✅ **完全自动化** - 安装后无需任何手动操作
✅ **不会被检测** - 在真实浏览器中运行，使用真实 Cookie
✅ **定时签到** - 每天 09:00 自动执行签到
✅ **手动签到** - 点击扩展图标可立即签到
✅ **实时通知** - 签到完成后桌面通知
✅ **可视化界面** - 查看签到状态和历史记录

---

## 安装步骤

### 1. 准备扩展文件

确保 `chrome-extension` 文件夹包含以下文件：
```
chrome-extension/
├── manifest.json
├── background.js
├── popup.html
├── popup.js
├── config.js
└── icons/
    └── (图标文件，可选)
```

### 2. 安装到 Chrome

1. **打开 Chrome 扩展管理页面**
   - 在地址栏输入：`chrome://extensions/`
   - 或点击：菜单 → 更多工具 → 扩展程序

2. **开启开发者模式**
   - 点击右上角的"开发者模式"开关

3. **加载扩展**
   - 点击"加载已解压的扩展程序"
   - 选择 `chrome-extension` 文件夹
   - 点击"选择文件夹"

4. **完成！**
   - 扩展已安装，可以在工具栏看到扩展图标

---

## 使用方法

### 首次使用

1. **登录目标网站**
   - 在 Chrome 中打开 https://ai.xingyungept.cn
   - 使用 linux.do 账号登录
   - 对其他站点重复此操作

2. **测试签到**
   - 点击扩展图标
   - 点击"立即签到"按钮
   - 查看签到结果

### 日常使用

- **自动签到**：每天 09:00 自动执行，无需操作
- **手动签到**：随时点击扩展图标 → 立即签到
- **查看状态**：点击扩展图标查看签到历史

---

## 配置说明

### 修改自动签到时间

编辑 `config.js` 文件：

```javascript
const GLOBAL_CONFIG = {
  autoSignTime: '09:00', // 修改为你想要的时间（24小时制）
  retryTimes: 2,
  requestTimeout: 10000
};
```

修改后需要重新加载扩展：
1. 打开 `chrome://extensions/`
2. 找到本扩展
3. 点击"重新加载"按钮

### 添加新站点

编辑 `config.js` 文件，在 `SITES_CONFIG` 数组中添加：

```javascript
{
  siteId: 'new_site',
  siteName: 'example.com',
  enabled: true,
  cookieDomain: 'example.com',
  signExecUrl: 'https://example.com/api/checkin',
  signExecMethod: 'POST',
  signExecParams: {},
  signQueryUrl: 'https://example.com/api/checkin',
  signQueryMethod: 'GET',
  cookieTestUrl: 'https://example.com/',
  unauthKeywords: ['未登录', '请登录']
}
```

### 禁用某个站点

将站点的 `enabled` 改为 `false`：

```javascript
{
  siteId: 'ai_xingyungept',
  siteName: 'ai.xingyungept.cn',
  enabled: false, // 禁用此站点
  // ...
}
```

---

## 常见问题

### Q1: 扩展安装后没有图标？

**答**：图标是可选的，不影响功能。如需添加图标：
1. 准备 16x16, 48x48, 128x128 三个尺寸的 PNG 图片
2. 命名为 icon16.png, icon48.png, icon128.png
3. 放入 `icons` 文件夹
4. 重新加载扩展

### Q2: 签到失败提示"未找到 Cookie"？

**答**：需要先在浏览器中登录目标网站：
1. 打开目标网站（如 https://ai.xingyungept.cn）
2. 使用 linux.do 账号登录
3. 确保登录成功后，再执行签到

### Q3: 签到失败提示"Cookie 已失效"？

**答**：Cookie 过期了，需要重新登录：
1. 打开目标网站
2. 退出登录
3. 重新使用 linux.do 登录
4. 再次尝试签到

### Q4: 如何查看签到日志？

**答**：
1. 打开 `chrome://extensions/`
2. 找到本扩展
3. 点击"service worker"（或"背景页"）
4. 在控制台查看详细日志

### Q5: 自动签到没有执行？

**答**：确保：
1. Chrome 浏览器保持运行（可以最小化）
2. 扩展没有被禁用
3. 检查扩展的定时器是否正常（查看背景页日志）

### Q6: 可以在其他浏览器使用吗？

**答**：
- **Edge**：可以，Edge 基于 Chromium，完全兼容
- **Firefox**：需要修改 manifest.json（Manifest V2）
- **Safari**：不支持

---

## 技术说明

### 权限说明

- **cookies**：读取网站 Cookie 用于签到
- **storage**：保存签到记录和配置
- **alarms**：设置定时任务
- **notifications**：发送签到通知

### 数据安全

- ✅ 所有数据存储在本地（Chrome Storage）
- ✅ Cookie 不会上传到任何服务器
- ✅ 仅访问配置的目标网站
- ✅ 开源代码，可审计

### 工作原理

1. 扩展从 Chrome 读取目标网站的 Cookie
2. 使用 Cookie 发送 HTTP 请求到签到接口
3. 解析响应结果，判断签到是否成功
4. 保存结果并发送通知

---

## 更新日志

### v1.0.0 (2026-03-08)
- ✨ 首次发布
- ✅ 支持 3 个站点自动签到
- ✅ 定时签到功能
- ✅ 手动签到功能
- ✅ 可视化界面
- ✅ 桌面通知

---

## 开发者

如需修改或扩展功能，请参考：
- [Chrome Extension 官方文档](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 迁移指南](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

## 许可证

MIT License

---

## 支持

如有问题或建议，请提交 Issue。
