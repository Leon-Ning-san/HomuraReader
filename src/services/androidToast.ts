import { isAndroid } from './platform.ts';

export async function showAndroidToast(message: string) {
  if (!isAndroid) return;
  try {
    await window.__TAURI__?.core?.invoke?.('plugin:android-toast|show', { message });
  } catch (error) {
    console.warn('[HOMURA] 显示 Android 提示失败', error);
  }
}
