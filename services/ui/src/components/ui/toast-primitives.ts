import { Toast } from '@base-ui/react/toast'

// Separate from toast.tsx so that file exports only components. The provider is
// mounted once at the app root and the hook is called from route components;
// neither is a component itself, and a module that mixes the two cannot be
// hot-swapped by Fast Refresh.
export const ToastProvider = Toast.Provider
export const useToast = Toast.useToastManager
