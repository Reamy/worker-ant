# 工蚁系统安全策略

> 参考 hermes-agent SECURITY.md 制定。明确安全边界、威胁模型、各层防护的局限性。

## 安全哲学

**进程内检查是启发式的，不是承载安全的边界。** 真正的安全边界是操作系统层的隔离（Docker 容器、文件系统权限、网络隔离）。

## 威胁模型

| 威胁向量               | 风险等级 | 缓解措施                                                                            |
| ---------------------- | -------- | ----------------------------------------------------------------------------------- |
| 提示注入（用户输入）   | 高       | `<user_content>` 标签包裹、10 种注入模式检测、Unicode 走私清理                      |
| 工具滥用（Agent 调用） | 高       | 五级权限(ReadOnly→Allow)、YOLO 分类器、工具熔断(连续3次)、no-progress 检测(连续5次) |
| 敏感信息泄露           | 中       | 7 种 PII 检测遮蔽、15 种危险代码模式检测、输出安全检查                              |
| 记忆投毒               | 中       | 记忆写入威胁扫描(security_audit)、去重合并、过期淘汰                                |
| 供应链攻击（MCP/A2A）  | 低       | ANS 注册中心审批制、HMAC 签名验证                                                   |
| DoS（资源耗尽）        | 中       | 成本限制(默认$0.50/任务)、Token 预算(100K/任务)、maxSteps(10)、子Agent 超时(5分钟)  |

## 安全层级

```
第一层：输入护栏（injection detection + unicode sanitization + user_content wrapping）
第二层：工具门控（五级权限 + YOLO classifier + circuit breaker + no-progress detection）
第三层：输出护栏（PII masking + dangerous code detection + cost limit + token budget）
第四层：基础设施（HMAC auth + JWT RBAC + Docker sandbox + network isolation）
```

## 已知局限性

1. **进程内检查非沙箱**：注入检测、YOLO 分类器等均为启发式检查，不能保证 100% 防御。生产环境建议 Docker 容器隔离。
2. **LLM 安全分类器为启发式**：YOLO 分类器基于工具名+调用历史的规则评分，非完整 LLM side-query。风险评分可能遗漏复杂攻击模式。
3. **Token 估算为近似值**：使用字符类型感知估算(4 字符/token ASCII, 1.5 字符/token CJK)，非精确 tiktoken 计数。
4. **Webhook 端点无额外认证**：IM webhook 回调端点(`/api/v1/im/webhook/:platform`)依赖平台自身的签名验证。建议部署在反向代理后并限制来源 IP。
5. **文件系统安全依赖 OS**：磁盘溢出的工具结果存储在 `data/task_outputs/`，无加密。敏感环境建议全盘加密。

## 报告安全问题

请通过 GitHub Issues 报告安全漏洞。勿在公开渠道披露。

## 定期审查

- 每季度审查依赖安全(`pnpm audit`)
- 每次发布前运行 `security_audit` 技能检查
- 生产环境定期红队测试
