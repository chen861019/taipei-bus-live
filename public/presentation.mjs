export function formatRelativeAge(value, referenceMs = Date.now()) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.floor((referenceMs - timestamp) / 1000));
  if (seconds < 5) return '剛剛';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  return `${Math.floor(minutes / 60)} 小時前`;
}

export function describeBusMotion(bus) {
  if (bus?.motionMode !== 'route') {
    return {
      label: '方位推估',
      detail: '未匹配路線，依官方速度與方位短時推估',
      tone: 'warning',
    };
  }
  const confidence = Number(bus.motionConfidence);
  if (Number.isFinite(confidence) && confidence < 45) {
    return { label: '低信心推估', detail: '已匹配路線，但目前定位誤差較大', tone: 'warning' };
  }
  if (Number.isFinite(confidence) && confidence < 75) {
    return { label: '路線推估', detail: '沿官方路線平滑推估，匹配信心一般', tone: 'neutral' };
  }
  return { label: '穩定推估', detail: '沿官方路線平滑推估，匹配信心高', tone: 'good' };
}
