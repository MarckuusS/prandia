/**
 * Ou en est la lecture des photos d'un article, en tete de sa feuille.
 *
 * Pendant la lecture, Savarin reflechit ; une lecture ratee (reseau du
 * magasin, ecran verrouille, photos illisibles) le dit et se relance avec les
 * memes photos. Une lecture reussie ne dit rien ici : les champs qu'elle a
 * remplis sont encadres de jaune, c'est la qu'on la lit.
 */

import { Savarin } from '../../components/Savarin.js'
import { peutRelancer, relancer, type Lecture } from './lecturesArticle.js'

export function LectureSavarin({ lecture }: { readonly lecture: Lecture | undefined }) {
  if (lecture === undefined) return null
  if (lecture.etat === 'lecture') {
    return (
      <p className="lecture-savarin" role="status">
        <Savarin size={22} occupe />
        Savarin lit tes photos…
      </p>
    )
  }
  if (lecture.etat === 'echec') {
    return (
      <div className="lecture-savarin lecture-savarin--echec" role="alert">
        <p className="lecture-savarin__texte">{lecture.erreur ?? 'La lecture a échoué.'}</p>
        {peutRelancer(lecture.cle) && (
          <button type="button" className="button button--ghost lecture-savarin__relancer" onClick={() => relancer(lecture.cle)}>
            Relancer la lecture
          </button>
        )}
      </div>
    )
  }
  return null
}
