import { setupWorker } from 'msw/browser'

import { handlers } from './handlers'
import { wsHandlers } from './ws-handlers'

export const worker = setupWorker(...handlers, ...wsHandlers)
