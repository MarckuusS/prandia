/**
 * Le cadre jaune de ce que Savarin vient de remplir (styles/ia.css), jusqu'a
 * la premiere retouche du champ. Le meme que dans la fiche d'un ingredient et
 * la revue d'un import : ce qui vient de l'IA se reconnait partout pareil.
 * Inactif, il ne change rien a la mise en page (marge negative, trait
 * transparent).
 */

import type { ReactNode } from 'react'

export function CadreIA({ actif, children }: { readonly actif: boolean; readonly children: ReactNode }) {
  return <div className={`champ-ia${actif ? ' champ-ia--rempli' : ''}`}>{children}</div>
}
