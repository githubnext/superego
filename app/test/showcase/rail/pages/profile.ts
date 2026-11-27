// The `rail` scene's own global profile (test/look.sh copies it into the home): a sidebar of pages and the space each
// opens (the Notes kind of section), and a rail button opening a board of its own, alone (the Vault kind).
import { defineProfile } from 'superego'

export default defineProfile({ global: true, description: 'Pages, for the rail scene', ui: ['./pages.tsx', './board.tsx'] })
