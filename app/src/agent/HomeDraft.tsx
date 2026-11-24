import React, { memo, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { type HomeTheme } from '../theme/homeTheme';
import { HomeComposer } from './HomeConversation';
import { type GlassTarget } from '../recovery/ConversationMotion';
import { FloatingChoices } from '../recovery/FloatingChoices';
import { HomeTextInput } from './HomeTextInput';

/** Both inputs share a draft without subscribing the screen or sheet to keystrokes. */
export function createHomeDraft() {
  let value = '';
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next: string) => { if (next === value) return; value = next; listeners.forEach(listener => listener()); },
  };
}
export type HomeDraft = ReturnType<typeof createHomeDraft>;
type Props = { draft: HomeDraft; busy: boolean; onChange: (value: string) => void; onSend: () => void; choices: string[]; onChoose: (value: string) => void; blurTarget?: GlassTarget; theme: HomeTheme };

export const HomeInputBar = memo(function HomeInputBar({ draft, busy, onChange, onSend, onFocus, onBlur, choices, onChoose, blurTarget, theme }: Props & { onFocus: () => void; onBlur: () => void }) {
  const value = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  const dark = theme.mode !== 'light';
  const tone = dark ? 'dark' : 'light';
  return <View style={s.dock} testID="home-input-dock"><FloatingChoices choices={busy ? [] : choices} disabled={busy} onChoose={onChoose} testIDPrefix="home-opening-choice" blurTarget={blurTarget} textColor={theme.text} iconColor={theme.muted} tone={tone} />
    <HomeTextInput theme={theme} value={value} busy={busy} onChange={onChange} onSend={onSend} onFocus={onFocus} onBlur={onBlur} placeholder="也可以直接说说…" inputTestID="agent-input" sendTestID="agent-send" />
  </View>;
});

export const HomeDraftComposer = memo(function HomeDraftComposer({ draft, busy, onChange, onSend, onStop, choices, onChoose, blurTarget, theme }: Props & { onStop: () => void }) {
  const input = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  return <HomeComposer input={input} busy={busy} onChange={onChange} onSend={onSend} onStop={onStop} choices={choices} onChoose={onChoose} blurTarget={blurTarget} theme={theme} />;
});
const s = StyleSheet.create({
  dock: { marginHorizontal: 24, marginBottom: 4 },
});
