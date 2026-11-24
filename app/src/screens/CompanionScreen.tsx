import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createChatVoiceSend } from '../integration/voiceSend';
import { LifePanel } from '../life';
import { MemoryPanel } from '../memory';
import { SettingsPanel } from '../settings';
import { colors, space, type } from '../theme/tokens';
import { VoicePanel } from '../voice';
import type { VoiceSend } from '../voice/controller';

const sections = [
  { key: 'settings', label: '连接与授权' },
  { key: 'life', label: '生活记录' },
  { key: 'memory', label: '有限记忆' },
  { key: 'voice', label: '语音对话' },
] as const;
type SectionKey = (typeof sections)[number]['key'];

/**
 * 陪伴首版的业务面板组合入口：每个面板自持平台单例 store，本屏只做分段切换，避免嵌套滚动容器。
 * 语音发送经 createChatVoiceSend 复用现有 NDJSON 聊天；桌面悬浮与外部相机持续观察为 Android 原生闭环，待设备验证后再在此接线角色。
 */
export function CompanionScreen({ visible = true }: { visible?: boolean }) {
  const [section, setSection] = useState<SectionKey>('settings');
  const onSend = useMemo<VoiceSend>(() => createChatVoiceSend(), []);
  if (!visible) return null;
  return (
    <View style={styles.root} testID="companion-screen">
      <View style={styles.segment} testID="companion-segment">
        {sections.map(item => (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            testID={`companion-tab-${item.key}`}
            onPress={() => setSection(item.key)}
            style={[styles.segmentItem, section === item.key && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, section === item.key && styles.segmentTextActive]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.body}>
        {section === 'settings' ? <SettingsPanel visible /> : null}
        {section === 'life' ? <LifePanel visible /> : null}
        {section === 'memory' ? <MemoryPanel visible /> : null}
        {section === 'voice' ? <VoicePanel onSend={onSend} visible /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  segment: { flexDirection: 'row', paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  segmentItem: { flex: 1, paddingVertical: space.sm, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center' },
  segmentActive: { backgroundColor: colors.text },
  segmentText: { ...type.caption, color: colors.text2 },
  segmentTextActive: { color: '#fff', fontWeight: '600' },
  body: { flex: 1 },
});
