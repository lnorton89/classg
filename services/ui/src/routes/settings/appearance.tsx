import { createFileRoute } from '@tanstack/react-router'
import { EyeIcon, MonitorIcon, MoonIcon, SmartphoneIcon, SunIcon } from 'lucide-react'

import { usePreferences, type Density, type TextScale } from '@/app/preferences-context'
import { useTheme, type ThemePreference } from '@/app/theme-context'
import { Segmented } from '@/components/ui/segmented'
import { SettingRow, SettingsCard, ToggleRow } from '@/features/settings/controls'

export const Route = createFileRoute('/settings/appearance')({ component: AppearanceSettings })

function AppearanceSettings() {
  const { preferences, setPreference } = usePreferences()
  const { preference: theme, setPreference: setTheme } = useTheme()

  return (
    <>
      <SettingsCard
        icon={EyeIcon}
        title="Display"
        description="How the console is drawn. Dark is the default and stays the default."
        why={
          <>
            This runs outdoors at night, where a white screen costs night vision as well as
            legibility. Reduce motion is honoured automatically when your operating system asks
            for it, so the switch is only for turning it on where the system has not.
          </>
        }
      >
        <SettingRow label="Theme">
          <Segmented
            aria-label="Theme"
            value={theme}
            onValueChange={(value: ThemePreference) => setTheme(value)}
            options={[
              { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
              { value: 'light', label: 'Light', icon: <SunIcon /> },
              { value: 'system', label: 'System', icon: <MonitorIcon /> },
            ]}
          />
        </SettingRow>

        <SettingRow label="Text size" hint="Scales the whole interface, map labels included.">
          <Segmented
            aria-label="Text size"
            value={preferences.textScale}
            onValueChange={(value: TextScale) => setPreference('textScale', value)}
            options={[
              { value: 'sm', label: 'Small' },
              { value: 'md', label: 'Default' },
              { value: 'lg', label: 'Large' },
              { value: 'xl', label: 'Largest' },
            ]}
          />
        </SettingRow>

        <SettingRow label="Density" hint="Tightens rows only; buttons keep their touch target.">
          <Segmented
            aria-label="Density"
            value={preferences.density}
            onValueChange={(value: Density) => setPreference('density', value)}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </SettingRow>

        <ToggleRow
          label="Reduce motion"
          checked={preferences.motion === 'reduced'}
          onCheckedChange={(checked) => setPreference('motion', checked ? 'reduced' : 'system')}
        />
      </SettingsCard>

      <SettingsCard
        icon={SmartphoneIcon}
        title="Field use"
        description="For a console left running on a tripod or a bench rather than watched continuously."
      >
        <ToggleRow
          label="Keep the screen awake"
          hint="Holds a wake lock while this tab is visible. Not supported in every browser."
          checked={preferences.keepAwake}
          onCheckedChange={(checked) => setPreference('keepAwake', checked)}
        />
      </SettingsCard>
    </>
  )
}
