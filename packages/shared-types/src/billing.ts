/** 计费记录 */
export interface BillingRecord {
  id: string;
  endpoint_id: string;
  model_id: string;
  project_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  created_at: string;
}

/** 资源使用统计 */
export interface ResourceUsage {
  model_id: string;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  call_count: number;
}
