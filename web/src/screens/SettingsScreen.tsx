import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { useCurrentUser } from '../AuthGate.js'
import { Icon, type IconName } from '../icons/index.js'
import { ApiError, apiFetch, logout, type HealthResponse } from '../lib/api.js'
import { currentZoomScale } from '../lib/gestures.js'
import { THEME_CHOICES, useTheme } from '../lib/theme.js'
import '../styles/settings.css'

/**
 * Parametres : ou l'on va depuis ici, qui est connecte, ce que repond le
 * serveur, et ce que l'appareil declare de son propre affichage.
 *
 * L'ecran est d'abord un DEPART. Cinq espaces n'ont pas d'autre porte d'entree
 * generale que celle-ci ; ils y ont longtemps ete des liens en plein texte, au
 * milieu de paragraphes explicatifs. Ils sont maintenant des lignes de liste,
 * les memes que partout ailleurs, et ils passent avant le diagnostic.
 *
 * Le diagnostic, lui, remplace le « dossier de logs » du desktop, qui ouvrait
 * l'explorateur de fichiers — sans equivalent dans un navigateur. C'est le
 * premier ecran a consulter quand quelque chose ne repond pas depuis le
 * telephone, et le seul moyen de diagnostiquer a distance : une capture de cet
 * ecran contient tout ce qu'il faut.
 */

/**
 * Une destination des parametres, dessinee comme une ligne de liste.
 *
 * Volontairement construite sur le vocabulaire commun — `row-list`, `row__link`,
 * `icon-chip`, `row__chevron` — celui des ingredients, des recettes et des
 * rayons. Un ecran de reglages qui invente ses propres lignes obligerait a
 * reapprendre a lire une liste, et les corrections faites a l'une ne
 * profiteraient pas a l'autre.
 */
function SettingsRow({
  to,
  icon,
  title,
  hint,
}: {
  readonly to: string
  readonly icon: IconName
  readonly title: string
  readonly hint: string
}) {
  return (
    <li className="row">
      <Link to={to} className="row__link lien-surface">
        <span className="icon-chip icon-chip--accent" aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        <span className="row__body">
          <span className="row__title">{title}</span>
          <span className="row__meta">{hint}</span>
        </span>
        <span className="row__chevron">
          <Icon name="ui-chevron-right" size={18} />
        </span>
      </Link>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Mesures de l'affichage
// ---------------------------------------------------------------------------

interface ViewportMetrics {
  readonly screenW: number
  readonly screenH: number
  readonly innerW: number
  readonly innerH: number
  readonly vh: number
  readonly dvh: number
  /** Position du bas de la barre d'onglets. Doit egaler la hauteur de l'ecran. */
  readonly tabbarBottom: number
  readonly tabbarHeight: number
  /** Pixels de fond nu visibles SOUS la barre d'onglets. Doit valoir 0. */
  readonly belowTabbar: number
  readonly safeTop: number
  readonly safeBottom: number
  readonly standalone: boolean
  /** Facteur de zoom. Doit valoir 1 : au-dela, le pincement a echappe au blocage. */
  readonly zoom: number
}

/**
 * Releve les mesures sur l'appareil lui-meme.
 *
 * Elles existent a cause d'un defaut precis : une fois installee sur un
 * iPhone, l'application laissait une bande de fond nu sous la barre d'onglets.
 * La cause n'etait visible que sur le telephone — iOS annonce un viewport plus
 * court que l'ecran, l'ecart valant exactement la hauteur de l'encoche (48 px
 * sur un iPhone 11). Sans un endroit ou lire ces nombres, ce genre de defaut se
 * diagnostique a l'aveugle.
 *
 * « Sous la barre » est LA mesure qui compte : elle doit valoir 0.
 */
function readMetrics(): ViewportMetrics {
  // On mesure les unites CSS elles-memes : c'est leur desaccord qui fait le
  // defaut, pas la valeur de l'une d'elles prise isolement.
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;height:100vh'
  document.body.appendChild(probe)
  const vh = probe.getBoundingClientRect().height
  probe.style.height = '100dvh'
  const dvh = probe.getBoundingClientRect().height
  document.body.removeChild(probe)

  const px = (value: string): number => Math.round(Number.parseFloat(value) || 0)
  const style = getComputedStyle(document.documentElement)

  // Positions REELLES, telles que le navigateur les a posees. Plus fiable que
  // de relire les regles CSS : `getPropertyValue('--app-height')` rend la
  // chaine « 100dvh », pas une longueur, et l'analyser donnerait 100.
  const tabbar = document.querySelector('.tabbar')
  const rect = tabbar?.getBoundingClientRect()
  const screenH = window.screen.height

  return {
    screenW: window.screen.width,
    screenH,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    vh: Math.round(vh),
    dvh: Math.round(dvh),
    tabbarBottom: rect ? Math.round(rect.bottom) : 0,
    tabbarHeight: rect ? Math.round(rect.height) : 0,
    // L'ecart entre le bas de la barre et le bas de la ZONE VISIBLE, signe :
    // positif, du fond apparait sous la barre ; negatif, la barre est coupee.
    // Il se mesurait contre l'ecran physique, ce qui supposait que la page
    // commence en haut de l'ecran. Depuis la barre d'etat opaque, elle
    // commence 48 px plus bas : la barre debordait de 48 px et la mesure
    // affichait 0.
    belowTabbar: rect ? Math.round(window.innerHeight - rect.bottom) : 0,
    safeTop: px(style.getPropertyValue('--safe-top')),
    safeBottom: px(style.getPropertyValue('--safe-bottom')),
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      // Safari iOS n'implemente pas display-mode et expose ce booleen non standard.
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
    zoom: currentZoomScale(),
  }
}

function useViewportMetrics(): ViewportMetrics {
  const [metrics, setMetrics] = useState(readMetrics)

  useEffect(() => {
    // Un premier relevé au montage : la barre d'onglets n'est pas forcement
    // posee au moment du rendu initial, et sa position fait toute la mesure.
    const refresh = () => setMetrics(readMetrics())
    const timer = setTimeout(refresh, 0)

    window.addEventListener('resize', refresh)
    window.addEventListener('orientationchange', refresh)
    // `visualViewport` est le SEUL a signaler un changement de zoom : un
    // pincement ne declenche pas `resize`. Sans cet ecouteur, la ligne « Zoom »
    // afficherait ×1 en permanence — donc mentirait exactement quand elle
    // servirait a quelque chose.
    const visual = window.visualViewport
    visual?.addEventListener('resize', refresh)
    visual?.addEventListener('scroll', refresh)

    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', refresh)
      window.removeEventListener('orientationchange', refresh)
      visual?.removeEventListener('resize', refresh)
      visual?.removeEventListener('scroll', refresh)
    }
  }, [])

  return metrics
}

// ---------------------------------------------------------------------------

export function SettingsScreen() {
  const me = useCurrentUser()
  const client = useQueryClient()
  const view = useViewportMetrics()
  const theme = useTheme()

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/api/health'),
    retry: false,
  })

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      client.setQueryData(['session'], { authenticated: false, user: null })
      client.clear()
    },
  })

  return (
    <section className="screen">
      {/* Les destinations D'ABORD, et sous la forme qu'elles ont partout
          ailleurs dans l'application : une ligne, une pastille, un chevron.
          Elles etaient des liens en plein texte au milieu de paragraphes — donc
          invisibles a qui parcourt l'ecran sans le lire, et minuscules a viser
          au pouce. Les cartes de diagnostic sont passees dessous : on vient ici
          pour aller quelque part bien plus souvent que pour relever un chiffre. */}
      <h2 className="section-header settings-group">Mon espace</h2>
      <ul className="row-list">
        <li className="row">
          <Link to="/objectifs/reglages" className="row__link lien-surface">
            {/* L'initiale plutot qu'un dessin : c'est la seule pastille de
                l'ecran qui designe quelqu'un, et la ligne du dessous porte
                deja une icone d'utilisateur si on en mettait une. */}
            <span className="icon-chip settings-avatar" aria-hidden="true">
              {me.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="row__body">
              <span className="row__title">Mon profil</span>
              <span className="row__meta">
                {me.displayName} · taille, poids, activité et objectif journalier
              </span>
            </span>
            <span className="row__chevron">
              <Icon name="ui-chevron-right" size={18} />
            </span>
          </Link>
        </li>
        <SettingsRow
          to="/activite"
          icon="ui-history"
          title="Journal d’activité"
          hint="Qui a ajouté, modifié ou supprimé quoi."
        />
      </ul>

      <h2 className="section-header settings-group">Personnalisation</h2>
      <ul className="row-list">
        <SettingsRow
          to="/parametres/notifications"
          icon="ui-clock"
          title="Notifications"
          hint="Choisir les rappels, leurs heures, et les appareils qui les reçoivent."
        />
        <SettingsRow
          to="/parametres/rayons"
          icon="ui-tag"
          title="Rayons"
          hint="Créer, renommer, colorer, supprimer les rayons."
        />
        <SettingsRow
          to="/parametres/mes-icones"
          icon="ui-palette"
          title="Mes icônes"
          hint="Coller un SVG pour l’ajouter aux icônes proposées."
        />
        <SettingsRow
          to="/parametres/icones"
          icon="ui-shapes"
          title="Jeu d’icônes"
          hint="Tous les dessins de l’application, et ce qu’ils couvrent."
        />
      </ul>

      <div className="card">
        <h2 className="card__title">Serveur</h2>

        {health.isPending && <p className="card__lead">Vérification…</p>}

        {health.isError && (
          <>
            <p className="status status--error">
              {health.error instanceof ApiError && health.error.isOffline
                ? 'API injoignable — pas de connexion.'
                : `API injoignable — ${(health.error as Error).message}`}
            </p>
            <p className="card__lead">
              Si le réseau est bon, ferme puis rouvre l’application : la session a peut-être expiré.
            </p>
          </>
        )}

        {health.isSuccess && (
          <>
            <p className="status status--ok">API joignable</p>
            <dl className="kv">
              <dt>Version API</dt>
              <dd>{health.data.version}</dd>
              <dt>Base</dt>
              <dd>{health.data.database.reachable ? 'connectée' : 'injoignable'}</dd>
              <dt>Ingrédients</dt>
              <dd>{health.data.database.ingredients ?? '—'}</dd>
            </dl>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="card__title">Thème</h2>
        <p className="card__lead">
          "Système" suit le réglage du téléphone, donc le passage automatique en sombre le soir.
        </p>
        <div className="segmented" role="group" aria-label="Thème de l’application">
          {THEME_CHOICES.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`segmented__tab${theme.choice === option.value ? ' segmented__tab--active' : ''}`}
              aria-pressed={theme.choice === option.value}
              onClick={() => theme.setChoice(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 className="card__title">Application</h2>
        <dl className="kv">
          <dt>Version</dt>
          <dd>{__APP_VERSION__}</dd>
          <dt>Construite le</dt>
          <dd>{new Date(__BUILD_TIME__).toLocaleString('fr-FR')}</dd>
          <dt>Mode</dt>
          <dd>{view.standalone ? 'installée' : 'onglet du navigateur'}</dd>
          <dt>Connexion</dt>
          <dd>{navigator.onLine ? 'en ligne' : 'hors ligne'}</dd>
        </dl>
      </div>

      <div className="card">
        <h2 className="card__title">Mesures de l’appareil</h2>
        <p className="card__lead">À envoyer en capture si l’affichage se comporte mal.</p>
        <dl className="kv">
          <dt>Écran</dt>
          <dd>
            {view.screenW} × {view.screenH}
          </dd>
          <dt>Viewport exposé</dt>
          <dd>
            {view.innerW} × {view.innerH}
          </dd>
          <dt>100vh</dt>
          <dd>{view.vh}</dd>
          <dt>100dvh</dt>
          <dd>{view.dvh}</dd>
          <dt>Hauteur de la barre</dt>
          <dd>{view.tabbarHeight}</dd>
          <dt>Bas de la barre</dt>
          <dd>{view.tabbarBottom}</dd>
          <dt>Sous la barre</dt>
          <dd>{view.belowTabbar}</dd>
          <dt>Marge système haute</dt>
          <dd>{view.safeTop}</dd>
          <dt>Marge système basse</dt>
          <dd>{view.safeBottom}</dd>
          <dt>Zoom</dt>
          <dd>{view.zoom === 1 ? 'bloqué (×1)' : `×${view.zoom.toFixed(2)}`}</dd>
        </dl>

        {/* La seule ligne qui demande une action. Les autres ne sont que du
            contexte pour la comprendre. */}
        {view.belowTabbar !== 0 && (
          <p className="status status--error" role="alert">
            {view.belowTabbar > 0
              ? `${view.belowTabbar} px de fond apparaissent sous la barre d’onglets.`
              : `La barre d’onglets dépasse de ${-view.belowTabbar} px sous le bord de l’écran.`}{' '}
            Envoie cette capture.
          </p>
        )}
      </div>

      <button
        type="button"
        className="button button--secondary"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        {signOut.isPending ? 'Déconnexion…' : 'Se déconnecter'}
      </button>
    </section>
  )
}
