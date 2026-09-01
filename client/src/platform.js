/** Adapta a experiência sem usar o user-agent como bloqueio de recurso. */
export function isMobileClient(navigatorLike = navigator) {
  return (
    navigatorLike.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigatorLike.userAgent ?? '')
  );
}

export function canCaptureScreen(navigatorLike = navigator, windowLike = window) {
  return Boolean(navigatorLike.mediaDevices?.getDisplayMedia && windowLike.VideoEncoder);
}

export function defaultBroadcastQuality(mobile) {
  return mobile ? { bitrate: 1_500_000, fps: 30 } : { bitrate: 2_500_000, fps: 30 };
}
