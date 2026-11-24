import { AppState, Platform } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import type { RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';
import { COMPANION_LIMITS } from '../companion/contracts';
import { requireTrue } from '../companion/core';
import type { NativeRecordingEnvironment, NativeRecordingResource } from './nativeRecorder';

// expo-audio 57 的原生 AudioModule 确有 AudioRecorder 构造器（NativeAudioModule.AudioRecorder），
// 但 Web 变体只提供 AudioRecorderWeb；eslint 按 Web 命名空间静态解析会误报该成员缺失。
// 这里以结构化类型收敛原生构造器：既保留 Android/iOS 真实构造，又不否认其存在，web 仍走 createWebRecorder。
const NativeRecorderCtor = (AudioModule as unknown as {
  AudioRecorder: new (options: Partial<RecordingOptions>) => NativeRecordingResource;
}).AudioRecorder;

/** 原生录音环境：唯一持有 expo-audio/expo-file-system 具体依赖的隔离层，取消与 release 交由 NativeRecorderAdapter。 */
export function createNativeRecordingEnvironment(): NativeRecordingEnvironment {
  return {
    requestPermission: () => AudioModule.requestRecordingPermissionsAsync(),
    isForeground: () => AppState.currentState === 'active',
    setRecordingMode: enabled => setAudioModeAsync({ allowsRecording: enabled, allowsBackgroundRecording: false, playsInSilentMode: true }),
    createRecorder: () => {
      // 与 Expo57 的平台选项合并规则一致；仅在主动开始时创建，适配器负责 release。
      const preset = RecordingPresets.HIGH_QUALITY;
      return new NativeRecorderCtor({ ...preset, isMeteringEnabled: false, ...(Platform.OS === 'ios' ? preset.ios : preset.android) });
    },
    readBytes: async uri => { const file = new File(uri); requireTrue(file.size <= COMPANION_LIMITS.maxAudioBytes, 'PAYLOAD_TOO_LARGE'); return file.bytes(); },
    discard: uri => { try { const file = new File(uri); if (file.exists) file.delete(); } catch {/* 缓存清理失败不输出设备路径。 */ } },
  };
}
