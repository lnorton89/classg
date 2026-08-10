/**
 * Runtime switches.
 *
 * MSW is on by default in dev so `npm run dev` works with no backend at all.
 * `VITE_USE_MSW=false npm run dev` points the app at a real Pi through the Vite
 * proxy instead.
 */
export const USE_MSW: boolean =
  import.meta.env.DEV && import.meta.env['VITE_USE_MSW'] !== 'false'
