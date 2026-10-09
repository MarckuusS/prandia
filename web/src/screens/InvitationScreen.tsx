import { useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'

import { MIN_PASSWORD_LENGTH } from '@prandia/shared'

import {
  ApiError,
  definirMotDePasse,
  lireInvitation,
  type SessionUser,
} from '../lib/api.js'

/**
 * Ecran d'invitation : choisir son mot de passe sur un compte deja cree.
 *
 * Il vit AVANT la garde d'authentification (voir AuthGate) : son destinataire
 * n'a pas encore de session, c'est tout l'objet.
 *
 * L'ecran commence par afficher DE QUEL COMPTE il s'agit. Une page qui
 * demanderait un mot de passe sans dire a quoi il servira ressemble a un
 * hameconnage, et le lien arrive justement par un message.
 */
export function InvitationScreen({
  jeton,
  onSuccess,
}: {
  jeton: string
  onSuccess: (user: SessionUser) => void
}) {
  const [motDePasse, setMotDePasse] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [erreur, setErreur] = useState<string | null>(null)
  const [occupe, setOccupe] = useState(false)

  const invitation = useQuery({
    queryKey: ['invitation', jeton],
    queryFn: () => lireInvitation(jeton),
    retry: false,
    staleTime: Infinity,
  })

  const tropCourt = motDePasse.length < MIN_PASSWORD_LENGTH
  const discordant = confirmation.length > 0 && motDePasse !== confirmation

  const soumettre = async (event: FormEvent) => {
    event.preventDefault()
    if (occupe || tropCourt || motDePasse !== confirmation) return
    setOccupe(true)
    setErreur(null)
    try {
      const { user } = await definirMotDePasse(jeton, motDePasse)
      setMotDePasse('')
      setConfirmation('')
      onSuccess(user)
    } catch (err) {
      setErreur(
        err instanceof ApiError ? err.message : 'Impossible d’enregistrer. Réessaie dans un instant.',
      )
    } finally {
      setOccupe(false)
    }
  }

  if (invitation.isPending) {
    return (
      <div className="login">
        <div className="card login__card" aria-busy="true">
          <span className="skeleton skeleton--line" />
        </div>
      </div>
    )
  }

  if (invitation.isError) {
    return (
      <div className="login">
        <div className="card login__card">
          <img className="login__logo" src="/icons/favicon.svg" width="72" height="72" alt="" />
          <h1 className="login__title">Invitation invalide</h1>
          <p className="card__lead">
            {invitation.error instanceof Error
              ? invitation.error.message
              : "Ce lien n'est plus valable."}
          </p>
        </div>
      </div>
    )
  }

  const { username, displayName, cuisine, genre } = invitation.data

  /*
   * « Bienvenue » ne s'adresse qu'a un nouveau venu.
   *
   * Le mecanisme est le meme dans les deux cas, l'accueil ne doit pas l'etre :
   * accueillir quelqu'un qui a simplement perdu son mot de passe sonne faux, et
   * laisse croire qu'un second compte vient d'etre cree a son nom.
   */
  const creation = genre === 'creation'

  return (
    <div className="login">
      <form className="card login__card" onSubmit={(e) => void soumettre(e)}>
        <img className="login__logo" src="/icons/favicon.svg" width="72" height="72" alt="" />
        <h1 className="login__title">
          {creation ? `Bienvenue, ${displayName}` : 'Nouveau mot de passe'}
        </h1>
        <p className="card__lead">
          {creation ? (
            <>
              Choisis ton mot de passe pour le compte <strong>{username}</strong>
              {cuisine ? <> et ta cuisine « {cuisine} ».</> : '.'}
            </>
          ) : (
            <>
              Choisis un nouveau mot de passe pour le compte <strong>{username}</strong>. Rien
              d’autre ne change : tes recettes, ton frigo et ton historique restent en place.
            </>
          )}
        </p>

        {/* Un champ `username` cache, en lecture seule : sans lui, le trousseau
            enregistre le mot de passe sans savoir a quel compte l'associer, et
            ne le proposera pas a la connexion suivante. */}
        <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />

        <input
          type="password"
          className="search-field login__field"
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
          placeholder="Mot de passe"
          autoComplete="new-password"
          autoFocus
          disabled={occupe}
          aria-label="Mot de passe"
        />

        <input
          type="password"
          className="search-field"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder="Confirme le mot de passe"
          autoComplete="new-password"
          enterKeyHint="go"
          disabled={occupe}
          aria-label="Confirme le mot de passe"
          aria-invalid={discordant}
        />

        {/* L'exigence est annoncee AVANT d'etre enfreinte, pas apres : la
            decouvrir au refus oblige a recommencer une saisie masquee. */}
        <p className="status">
          {discordant
            ? 'Les deux saisies diffèrent.'
            : `Au moins ${MIN_PASSWORD_LENGTH} caractères.`}
        </p>

        {erreur && (
          <p className="status status--error" role="alert">
            {erreur}
          </p>
        )}

        <button
          type="submit"
          className="button button--primary login__submit"
          disabled={occupe || tropCourt || motDePasse !== confirmation}
        >
          {occupe ? 'Enregistrement…' : 'Entrer'}
        </button>
      </form>
    </div>
  )
}
