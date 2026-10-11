/**
 * La photo de garde, dans l'editeur de recette.
 *
 * ELLE S'ENREGISTRE TOUTE SEULE, sans attendre le bouton Enregistrer. Ce n'est
 * pas une facilite, c'est ce qui rend la fonction fiable : cet editeur ne
 * resynchronise jamais son tampon depuis la prop, donc une photo qui voyagerait
 * dedans serait effacee par un editeur reste ouvert ailleurs ; et iOS recharge
 * la page sous pression memoire, dont le televersement d'une photo est un
 * declencheur documente. Voir `draft.ts`, ou le champ a ete retire.
 *
 * UN SEUL BOUTON ET UN SEUL `<input>`. Pas de choix "prendre une photo" contre
 * "choisir dans la photothèque" : la feuille d'action du systeme propose deja
 * les deux, dans la langue du telephone, et mieux que nous.
 */

import { useEffect, useRef, useState } from 'react'
import { photoPath } from '@prandia/shared'

import { FieldShell, useFieldIds } from '../../components/Field.js'
import { Icon } from '../../icons/index.js'
import { PhotoIllisibleError, reduirePhoto } from '../../lib/photo.js'
import { meilleurePhotoDuSite } from '../../lib/photoSite.js'
import { fetchImagesDuSite, useDeleteRecipePhoto, useSetRecipePhoto } from '../../lib/queries.js'

type Etat = 'repos' | 'site' | 'preparation' | 'envoi'

/**
 * `lienSource` : l'adresse d'origine d'une recette importee, deja repassee par
 * `lienRecette`. Sans photo, elle offre "Reprendre la photo du site" : un
 * import peut la manquer (site lent, refus passager), et la recette existe
 * deja, on ne va pas la reimporter pour une image.
 */
export function PhotoField({
  recipeId,
  imageKey,
  lienSource = null,
}: {
  readonly recipeId: number
  readonly imageKey: string | null
  readonly lienSource?: string | null
}) {
  const [etat, setEtat] = useState<Etat>('repos')
  const [erreur, setErreur] = useState<string | null>(null)
  /**
   * L'apercu LOCAL, garde jusqu'a la fin de l'edition.
   *
   * Il vient de l'objet REDUIT, pas du fichier d'origine : c'est exactement ce
   * qu'on envoie, donc il ne ment ni sur le cadrage ni sur l'orientation apres
   * passage par le canvas, et l'on evite de decoder la photo une seconde fois.
   *
   * On ne bascule PAS sur l'URL servie apres l'envoi : elle est neuve, donc
   * absente du cache, et le navigateur retelechargerait tout de suite, en
   * donnees mobiles, l'image qu'on vient d'envoyer.
   */
  const [apercu, setApercu] = useState<string | null>(null)
  const [echecDistant, setEchecDistant] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const depose = useSetRecipePhoto(recipeId)
  const retire = useDeleteRecipePhoto(recipeId)

  useEffect(() => () => { if (apercu !== null) URL.revokeObjectURL(apercu) }, [apercu])

  const ids = useFieldIds(undefined, { error: erreur })

  const reprendreDuSite = async () => {
    if (lienSource === null) return
    setErreur(null)
    setEtat('site')
    let photo: Blob | null = null
    try {
      photo = await meilleurePhotoDuSite((await fetchImagesDuSite(lienSource)).imageUrls)
    } catch {
      // Page illisible ou site qui refuse : meme message qu'une photo absente.
    }
    if (photo === null) {
      setErreur('La photo du site n’a pas pu être récupérée. Réessaie plus tard, ou ajoute la tienne.')
      setEtat('repos')
      return
    }
    // Reduite comme a l'import : l'image d'un site est deja compressee.
    await choisir(photo, 'import')
  }

  const choisir = async (fichier: Blob, usage?: 'import') => {
    setErreur(null)
    setEtat('preparation')
    try {
      const reduite = await reduirePhoto(fichier, usage)

      // L'apercu apparait AVANT la fin de l'envoi : sur un reseau de magasin,
      // l'attente se compte en secondes, et un ecran qui ne bouge pas se lit
      // comme un echec.
      setApercu((ancien) => {
        if (ancien !== null) URL.revokeObjectURL(ancien)
        return URL.createObjectURL(reduite.cover)
      })

      setEtat('envoi')
      await depose.mutateAsync({ cover: reduite.cover, thumb: reduite.thumb })
      setEchecDistant(false)
    } catch (e: unknown) {
      // Le message du serveur est redige pour l'utilisateur final : on le
      // remonte tel quel, c'est lui qui nomme le format refuse.
      setErreur(
        e instanceof PhotoIllisibleError || e instanceof Error
          ? e.message
          : "L'envoi a échoué. Réessaie.",
      )
      setApercu((ancien) => {
        if (ancien !== null) URL.revokeObjectURL(ancien)
        return null
      })
    } finally {
      setEtat('repos')
    }
  }

  const enlever = async () => {
    setErreur(null)
    try {
      await retire.mutateAsync()
      setApercu((ancien) => {
        if (ancien !== null) URL.revokeObjectURL(ancien)
        return null
      })
      setEchecDistant(false)
    } catch (e: unknown) {
      setErreur(e instanceof Error ? e.message : 'Le retrait a échoué. Réessaie.')
    }
  }

  const occupe = etat !== 'repos' || retire.isPending
  const source =
    apercu ?? (imageKey !== null && !echecDistant ? photoPath(recipeId, imageKey, 'cover') : null)

  return (
    <FieldShell
      ids={ids}
      label="Photo de garde"
      error={erreur}
      hint="Elle s’enregistre tout de suite, sans attendre le bouton Enregistrer."
      className="champ-photo"
    >
      <div className="champ-photo__cadre">
        {source === null ? (
          <span className="champ-photo__vide">
            <Icon name="ui-camera" size={28} strokeWidth={1.6} />
            <span>Aucune photo</span>
          </span>
        ) : (
          <img
            className="champ-photo__image"
            src={source}
            alt=""
            /* Une cle peut designer un objet absent, et une session expiree
               rend un 401 : dans les deux cas un <img> affiche le carre casse
               du navigateur, et l'utilisateur croit avoir perdu sa photo. Le
               repli doit etre INDISCERNABLE de l'absence de photo. */
            onError={() => setEchecDistant(true)}
          />
        )}
      </div>

      <div className="champ-photo__actions">
        <button
          type="button"
          id={ids.controlId}
          className="button button--secondary"
          disabled={occupe}
          onClick={() => inputRef.current?.click()}
        >
          {etat === 'preparation'
            ? 'Préparation…'
            : etat === 'envoi'
              ? 'Envoi…'
              : source === null
                ? 'Ajouter une photo'
                : 'Remplacer'}
        </button>

        {source === null && lienSource !== null && (
          <button
            type="button"
            className="button button--ghost champ-photo__site"
            disabled={occupe}
            onClick={() => void reprendreDuSite()}
          >
            {etat === 'site' ? 'Recherche…' : 'Reprendre la photo du site'}
          </button>
        )}

        {source !== null && (
          <button
            type="button"
            className="button button--ghost champ-photo__retirer"
            disabled={occupe}
            onClick={() => void enlever()}
          >
            {retire.isPending ? 'Retrait…' : 'Retirer'}
          </button>
        )}
      </div>

      {/*
        `accept` reste COURT, et c'est mesure : depuis Safari 17, si `accept`
        mentionne image/heic, Safari convertit VERS le HEIC tout ce qu'on lui
        donne, y compris un JPEG deja parfait, et aucun reglage utilisateur ne
        l'evite.

        PAS DE `capture` non plus : sur iOS il ouvre directement l'appareil
        photo et FAIT DISPARAITRE la photothèque, sans retour possible. Or une
        photo de plat existe presque toujours avant qu'on ouvre l'application.
      */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const fichier = e.target.files?.[0]
          // La valeur est vidée pour que rechoisir LE MEME fichier redeclenche
          // l'evenement : sans cela, une deuxieme tentative apres une erreur ne
          // ferait rien du tout.
          e.target.value = ''
          if (fichier !== undefined) void choisir(fichier)
        }}
      />
    </FieldShell>
  )
}
