// 输出组装：按约定的 JSON 结构输出监控结果

export function buildOutput(payload) {
  const {
    stock,
    checkTime,
    mode,
    coveredRange,
    overallLevel,
    headline,
    events,
    fundFlowSnapshot,
    pendingData,
    dataSourceIssues,
    watchNext,
    lastSuccessTimestamp,
  } = payload;
  return {
    stock: stock ? `${stock.name} ${stock.code}` : null,
    check_time: checkTime,
    mode,
    covered_range: coveredRange,
    overall_level: overallLevel,
    headline,
    events: overallLevel === '无新增' ? [] : events,
    fund_flow_snapshot: fundFlowSnapshot,
    pending_data: pendingData || [],
    data_source_issues: dataSourceIssues || [],
    watch_next: watchNext || [],
    last_success_timestamp: lastSuccessTimestamp,
    disclaimer: '仅为信息整理，不构成投资建议',
  };
}

// 根据事件列表计算整体级别（红>黄>绿>无新增）
export function overallLevel(events) {
  if (!events || events.length === 0) return '无新增';
  if (events.some((e) => e.level === '红')) return '红';
  if (events.some((e) => e.level === '黄')) return '黄';
  return '绿';
}
