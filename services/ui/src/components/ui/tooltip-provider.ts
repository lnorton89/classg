import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'

// Separate from tooltip.tsx so that file exports only components. The provider
// is mounted once at the app root; the Tooltip beside it is used everywhere.
export const TooltipProvider = BaseTooltip.Provider
