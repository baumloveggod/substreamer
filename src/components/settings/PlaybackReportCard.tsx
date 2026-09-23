import { StyleSheet, Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { supportsExtension } from '../../services/serverCapabilityService';
import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { settingsStyles } from '../../styles/settingsStyles';
import { SettingsSectionTitle } from './SettingsSectionTitle';

/**
 * Live playback reporting. Renders nothing on a server that doesn't advertise
 * the `playbackReport` extension — a toggle that cannot do anything is worse
 * than no toggle.
 */
export function PlaybackReportCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const enabled = playbackSettingsStore((s) => s.reportPlaybackEnabled);
  const setEnabled = playbackSettingsStore((s) => s.setReportPlaybackEnabled);

  if (!supportsExtension('playbackReport')) return null;

  return (
    <View style={settingsStyles.section}>
      <SettingsSectionTitle>{t('playbackReporting')}</SettingsSectionTitle>
      <View style={[settingsStyles.card, { backgroundColor: colors.card }]}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleText}>
            <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>
              {t('reportPlaybackEnable')}
            </Text>
          </View>
          <Switch
            testID="playback-report-toggle"
            value={enabled}
            onValueChange={setEnabled}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>
      </View>
      <Text style={[settingsStyles.sectionHint, { color: colors.textSecondary }]}>
        {t('reportPlaybackHint')}
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
  },
  toggleText: { flex: 1 },
  toggleLabel: { fontSize: 16, fontWeight: '500' },
});
