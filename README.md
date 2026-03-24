通过 Cloudflare Dashboard 网页部署（无需命令行）

第一阶段：创建 KV 存储空间
1. 登录 Cloudflare Dashboard
打开 dash.cloudflare.com 登录账号。
2. 进入 KV 页面
左侧菜单点击 Workers & Pages → 点击 KV
3. 创建 KV Namespace
点击右上角 Create a namespace，输入名称 DOMAIN_MANAGER_KV，点击 Add。
创建成功后，列表里会出现这条记录，复制右侧的 ID（类似 a1b2c3d4e5f6789...），先保存备用。

第二阶段：创建 Worker
4. 新建 Worker
左侧点击 Workers & Pages → 点击 Create → 选择 Create Worker
名称填写 domain-manager，点击 Deploy（先随便部署，之后替换代码）。
5. 替换代码
部署成功后，点击 Edit code 进入在线编辑器。
把左侧编辑器里的所有内容全部删除，然后把 worker.js 的完整内容粘贴进去。
点击右上角 Deploy 部署。

第三阶段：绑定 KV & 设置密码
6. 进入 Worker 设置
回到 Worker 详情页，点击顶部 Settings 标签。
7. 绑定 KV Namespace
下滑找到 Bindings → 点击 Add → 选择 KV Namespace：

Variable name 填写：KV
KV Namespace 选择：DOMAIN_MANAGER_KV

点击 Save。
8. 设置管理员密码
同样在 Settings 页面，找到 Variables and Secrets → 点击 Add：

Type 选择：Secret
Variable name 填写：ADMIN_PASSWORD
Value 填写：你的登录密码

点击 Save。

⚠️ 设置完 Bindings 和 Secret 后，需要重新部署才生效：回到 Deployments 标签 → 点击最新那条 → Rollback to this deployment，或者重新进 Edit code 再点一次 Deploy。


第四阶段：设置定时任务
9. 配置 Cron 触发器
在 Worker 详情页，点击 Settings → 找到 Triggers → Cron Triggers → 点击 Add：
填写：0 9 * * *（每天 UTC 09:00，即北京时间 17:00）
点击 Add Trigger。

第五阶段：配置 Telegram 机器人
10. 创建机器人
打开 Telegram → 搜索 @BotFather → 发送 /newbot → 按提示操作 → 保存获得的 Bot Token。
11. 注册 Webhook
在浏览器地址栏直接访问（替换其中的内容）：
https://api.telegram.org/bot【你的Token】/setWebhook?url=https://domain-manager.【你的账号名】.workers.dev/api/telegram/webhook
看到 {"ok":true} 即成功。

Worker 的完整 URL 在 Worker 详情页顶部可以找到，格式是 https://domain-manager.xxxx.workers.dev

12. 获取 Chat ID
在 Telegram 找到你的机器人，发送 /start，机器人会回复你的 Chat ID。
13. 在管理后台填写配置
打开你的 Worker URL → 用密码登录 → 点击顶部「设置」→ 填入 Bot Token 和 Chat ID → 保存。

完成 ✅
步骤位置管理后台https://domain-manager.你的账号.workers.dev修改代码Dashboard → Workers → Edit code查看日志Dashboard → Workers → Logs手动触发检查管理后台 → 点击「🔔 检查续约」# new
获取 Cloudflare API Token

登录 Cloudflare → 右上角头像 → My Profile
左侧点 API Tokens → Create Token
选模板 Read All Resources（只读权限，安全）
点 Continue to Summary → Create Token
复制 Token（只显示一次，立即保存）

在管理后台同步

登录后台 → 点顶部 账号
点 + 添加 CF 账号 → 填入 Token → 点「验证并添加」
验证通过后，点账号卡片上的 ↻ 同步域名
预览页面会列出所有域名和到期日期，确认后点确认同步
