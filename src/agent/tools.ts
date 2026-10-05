import type { ActionAuthorizationService } from '../domain/authorization.js';
import type { ModelToolCall, ModelToolDefinition } from '../providers/model.js';

export type ToolEffect = 'read' | 'write';
export type ToolPermissionPolicy = 'auto' | 'requires_user_grant';

export interface ToolExecutionContext {
  actorId: string;
  sessionId: string;
  tripId: string;
  actionRequestId?: string;
  grantId?: string;
  digest?: string;
  now: string;
  /** 服务端注入，模型不能改变。 */
  allowedToolNames?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface ToolHandlerResult {
  result?: unknown;
  error?: { code: string; message: string };
  /** 写工具提交后的审计引用。 */
  mutationId?: string;
  resourceRef?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  permissionPolicy: ToolPermissionPolicy;
  /** 默认由网关消费许可；业务服务需要与事务一起消费时设为 handler。 */
  grantConsumption?: 'gateway' | 'handler';
  handler: (
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) => Promise<ToolHandlerResult> | ToolHandlerResult;
}

export type ToolExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'awaiting_approval'
  | 'cancelled';

export interface ToolExecutionResult {
  callId: string;
  toolName: string;
  status: ToolExecutionStatus;
  result?: unknown;
  error?: { code: string; message: string };
  actionRequestId?: string;
  mutationId?: string;
  committed?: boolean;
}

export interface BatchExecutionResult {
  results: ToolExecutionResult[];
  status: 'completed' | 'awaiting_approval' | 'failed';
}

/**
 * 极简 JSON Schema 校验，只覆盖工具目录实际使用的关键字。
 *
 * 模型可能给出 NaN 版本号或漏掉必填参数；放行会让领域层抛出误导性的冲突错误
 * （例如 `Number(undefined)` → NaN → REVISION_CONFLICT，而不是 INVALID_INPUT）。
 */
function validateToolArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { code: string; message: string } | null {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return { code: 'INVALID_INPUT', message: `缺少必填参数：${key}` };
    }
  }
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const rule = properties[key];
    if (!rule) continue;
    const type = rule.type;
    if (type === 'string' && typeof value !== 'string') {
      return { code: 'INVALID_INPUT', message: `参数 ${key} 必须是字符串。` };
    }
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return { code: 'INVALID_INPUT', message: `参数 ${key} 必须是有限数字。` };
    }
    if (type === 'boolean' && typeof value !== 'boolean') {
      return { code: 'INVALID_INPUT', message: `参数 ${key} 必须是布尔值。` };
    }
    if (type === 'array' && !Array.isArray(value)) {
      return { code: 'INVALID_INPUT', message: `参数 ${key} 必须是数组。` };
    }
    if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      return { code: 'INVALID_INPUT', message: `参数 ${key} 必须是对象。` };
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      return { code: 'INVALID_INPUT', message: `参数 ${key} 只能是 ${rule.enum.join('、')}。` };
    }
  }
  return null;
}

/**
 * 工具网关：白名单、参数引用、授权和一次性许可都在这里统一校验。
 * 公开 API 不暴露任意函数名入口。
 */
export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly authorization: ActionAuthorizationService) {}

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  listDefinitions(allowed?: readonly string[]): ModelToolDefinition[] {
    return [...this.tools.values()]
      .filter((tool) => !allowed || allowed.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  private isWrite(tool: ToolDefinition): boolean {
    return tool.effect === 'write' || tool.permissionPolicy === 'requires_user_grant';
  }

  private async executeOne(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (context.allowedToolNames && !context.allowedToolNames.includes(call.name)) {
      return {
        callId: call.callId,
        toolName: call.name,
        status: 'denied',
        error: { code: 'TOOL_NOT_ALLOWED', message: '当前任务不允许调用该工具。' },
      };
    }
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        callId: call.callId,
        toolName: call.name,
        status: 'denied',
        error: { code: 'TOOL_NOT_FOUND', message: '工具未注册。' },
      };
    }

    // 参数在进入授权与业务写入之前就必须校验，避免 NaN／缺字段一路传到领域层。
    const invalidArgs = validateToolArguments(tool.inputSchema, call.arguments ?? {});
    if (invalidArgs) {
      return {
        callId: call.callId,
        toolName: call.name,
        status: 'failed',
        error: invalidArgs,
      };
    }

    let actionRequestId = context.actionRequestId;
    if (this.isWrite(tool)) {
      if (!context.grantId) {
        const args = JSON.stringify(call.arguments ?? {});
        actionRequestId = actionRequestId ?? `action_${call.callId}`;
        const created = this.authorization.createRequest({
          actionRequestId,
          tripId: context.tripId,
          actorId: context.actorId,
          sessionId: context.sessionId,
          toolName: call.name,
          canonicalArgs: call.arguments ?? {},
          summary: `${tool.description}（${args.slice(0, 80)}）`,
          createdAt: context.now,
          expiresAt:
            (context.metadata?.approvalExpiresAt as string | undefined) ??
            new Date(Date.parse(context.now) + 5 * 60 * 1000).toISOString(),
          proposalId:
            typeof call.arguments?.proposalId === 'string'
              ? call.arguments.proposalId
              : undefined,
          candidateId:
            typeof call.arguments?.candidateId === 'string'
              ? call.arguments.candidateId
              : undefined,
          baseRevision:
            typeof call.arguments?.expectedRevision === 'number'
              ? call.arguments.expectedRevision
              : undefined,
        });
        if (!created.ok) {
          return {
            callId: call.callId,
            toolName: call.name,
            status: 'failed',
            error: created.error ?? { code: 'ACTION_REQUEST_FAILED', message: '创建动作请求失败。' },
          };
        }
        return {
          callId: call.callId,
          toolName: call.name,
          status: 'awaiting_approval',
          actionRequestId,
        };
      }

      const handlerConsumesGrant = tool.grantConsumption === 'handler';
      const granted = handlerConsumesGrant
        ? this.authorization.validateGrant({
            grantId: context.grantId,
            actionRequestId,
            actorId: context.actorId,
            sessionId: context.sessionId,
            digest: context.digest,
            now: context.now,
          })
        : this.authorization.consumeGrant({
            grantId: context.grantId,
            actionRequestId,
            actorId: context.actorId,
            sessionId: context.sessionId,
            digest: context.digest,
            now: context.now,
          });
      if (!granted.ok) {
        return {
          callId: call.callId,
          toolName: call.name,
          status: 'denied',
          error: granted.error ?? { code: 'ACTION_AUTHORIZATION_INVALID', message: '许可无效。' },
        };
      }
      if (handlerConsumesGrant && !context.actionRequestId) {
        return {
          callId: call.callId,
          toolName: call.name,
          status: 'denied',
          error: { code: 'ACTION_AUTHORIZATION_INVALID', message: '缺少动作请求引用。' },
        };
      }
    }

    try {
      const handled = await tool.handler(call.arguments ?? {}, context);
      if (handled.error) {
        return {
          callId: call.callId,
          toolName: call.name,
          status: 'failed',
          error: handled.error,
          actionRequestId,
        };
      }
      return {
        callId: call.callId,
        toolName: call.name,
        status: 'succeeded',
        result: handled.result,
        actionRequestId,
        mutationId: handled.mutationId,
        committed: this.isWrite(tool),
      };
    } catch (error) {
      return {
        callId: call.callId,
        toolName: call.name,
        status: 'failed',
        error: { code: 'TOOL_EXECUTION_FAILED', message: (error as Error).message },
        actionRequestId,
      };
    }
  }

  /**
   * 同一模型回合最多一个写调用；其余写调用明确返回 WRITE_BATCH_NOT_SUPPORTED，
   * 不会因为排在数组后面就被跳过执行。
   */
  async executeBatch(
    calls: readonly ModelToolCall[],
    context: ToolExecutionContext,
  ): Promise<BatchExecutionResult> {
    const results: ToolExecutionResult[] = [];
    let writeSeen = false;
    for (const call of calls) {
      const tool = this.tools.get(call.name);
      if (tool && this.isWrite(tool) && writeSeen) {
        results.push({
          callId: call.callId,
          toolName: call.name,
          status: 'failed',
          error: {
            code: 'WRITE_BATCH_NOT_SUPPORTED',
            message: '一次模型回合最多执行一个写调用。',
          },
        });
        continue;
      }
      if (tool && this.isWrite(tool)) writeSeen = true;
      results.push(await this.executeOne(call, context));
    }
    const status = results.some((result) => result.status === 'awaiting_approval')
      ? 'awaiting_approval'
      : results.some((result) => result.status === 'failed')
        ? 'failed'
        : 'completed';
    return { results, status };
  }
}
