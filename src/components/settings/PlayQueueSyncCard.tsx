import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { fetchServerQueue, saveQueueToServer } from '../../services/playQueueSyncService';
import { restoreServerQueue } from '../../services/playerService';
import {
  playbackSettingsStore,
  QUEUE_SYNC_INTERVALS,
  type QueueSyncInterval,
} from '../../store/playbackSettingsStore';
import { settingsStyles } from '../../styles/settingsStyles';
import { DropdownRow, type DropdownOption } from './DropdownRow';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Mirrors the play queue to the server so another client can carry on from the
 * same track and position. Autosave counts track changes; the two buttons do it
 * on demand in either direction.
 */
export function PlayQueueSyncCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { alert, confirm } = useThemedAlert();
  const [busy, setBusy] = useState<'save' | 'restore' | null>(null);

  const enabled = playbackSettingsStore((s) => s.queueSyncEnabled);
  const interval = playbackSettingsStore((s) => s.queueSyncInterval);
  const setEnabled = playbackSettingsStore((s) => s.setQueueSyncEnabled);
  const setInterval = playbackSettingsStore((s) => s.setQueueSyncInterval);

  const intervalOptions: DropdownOption<QueueSyncInterval>[] = useMemo(
    () =>
      QUEUE_SYNC_INTERVALS.map((v) => ({
        value: v,
        label: v === 1 ? t('queueSyncEveryTrack') : t('queueSyncEveryNTracks', { count: v }),
      })),
    [t],
  );

  const handleSave = useCallback(async () => {
    setBusy('save');
    try {
      const saved = await saveQueueToServer();
      alert(
        saved ? t('queueSyncSaved') : t('queueSyncFailed'),
        saved ? undefined : t('queueSyncFailedMessage'),
      );
    } finally {
      setBusy(null);
    }
  }, [alert, t]);

  const handleRestore = useCallback(() => {
    confirm({
      title: t('queueSyncRestore'),
      message: t('queueSyncRestoreMessage'),
      confirmLabel: t('queueSyncRestoreConfirm'),
      onConfirm: () => {
        void (async () => {
          setBusy('restore');
          try {
            const remote = await fetchServerQueue();
            if (!remote) {
              alert(t('queueSyncNoServerQueue'), t('queueSyncNoServerQueueMessage'));
              return;
            }
            const restored = await restoreServerQueue(
              remote.entry,
              remote.index,
              remote.positionMs / 1000,
            );
            if (!restored) alert(t('queueSyncFailed'), t('queueSyncRestoreEmptyMessage'));
          } finally {
            setBusy(null);
          }
        })();
      },
    });
  }, [alert, confirm, t]);

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('playQueueSync')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <View style={[styles.toggleRow, { borderBottomColor: colors.border }]}>
          <View style={styles.toggleText}>
            <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>
              {t('queueSyncEnable')}
            </Text>
          </View>
          <Switch
            testID="queue-sync-toggle"
            value={enabled}
            onValueChange={setEnabled}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>

        {enabled && (
          <DropdownRow
            label={t('queueSyncInterval')}
            value={interval}
            options={intervalOptions}
            onChange={setInterval}
          />
        )}

        <View style={settingsStyles.actionRow}>
          <Pressable
            onPress={handleSave}
            disabled={busy !== null}
            style={({ pressed }) => [
              settingsStyles.actionRowButton,
              { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
              pressed && settingsStyles.pressed,
              busy !== null && settingsStyles.disabled,
            ]}
          >
            {busy === 'save' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Ionicons name="cloud-upload-outline" size={18} color={colors.textPrimary} />
            )}
            <Text style={[settingsStyles.actionRowButtonText, { color: colors.textPrimary }]}>
              {t('queueSyncSave')}
            </Text>
          </Pressable>
          <Pressable
            onPress={handleRestore}
            disabled={busy !== null}
            style={({ pressed }) => [
              settingsStyles.actionRowButton,
              { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
              pressed && settingsStyles.pressed,
              busy !== null && settingsStyles.disabled,
            ]}
          >
            {busy === 'restore' ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <Ionicons name="cloud-download-outline" size={18} color={colors.textPrimary} />
            )}
            <Text style={[settingsStyles.actionRowButtonText, { color: colors.textPrimary }]}>
              {t('queueSyncRestore')}
            </Text>
          </Pressable>
        </View>
      </View>
      <Text style={[settingsStyles.sectionHint, { color: colors.textSecondary }]}>
        {t('queueSyncHint')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toggleText: { flex: 1 },
  toggleLabel: { fontSize: 16, fontWeight: '500' },
});
