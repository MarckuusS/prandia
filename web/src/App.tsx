import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router'

import { useCurrentUser } from './AuthGate.js'
import { ToastProvider } from './components/Toast.js'
import { Icon, type IconName } from './icons/index.js'
import { useTheme } from './lib/theme.js'
import { IconGalleryScreen } from './screens/IconGalleryScreen.js'
import { CustomIconsScreen } from './screens/CustomIconsScreen.js'
import { NotificationsScreen } from './screens/NotificationsScreen.js'
import { AccueilScreen, libelleDuJour } from './screens/AccueilScreen.js'
import { ProfileScreen } from './screens/ProfileScreen.js'
import { ScanScreen } from './screens/ScanScreen.js'
import { RayonsScreen } from './screens/RayonsScreen.js'
import { IngredientDetailScreen, IngredientsScreen } from './screens/IngredientsScreen.js'
import { PantryScreen } from './screens/PantryScreen.js'
import { RecipeDetailScreen } from './screens/RecipesScreen.js'
import { Repertoire } from './screens/recettes/Repertoire.js'
import { RecipeView } from './screens/recettes/RecipeView.js'
import { ImportRecette } from './screens/recettes/ImportRecette.js'
import { ActivityScreen } from './screens/ActivityScreen.js'
import { ObjectifsScreen } from './screens/ObjectifsScreen.js'
import { SettingsScreen } from './screens/SettingsScreen.js'
import { ShoppingScreen } from './screens/ShoppingScreen.js'
import { DayScreen } from './screens/DayScreen.js'
import { WeekScreen } from './screens/WeekScreen.js'

/**
 * QUATRE onglets, plus un bouton de scan au centre.
 *
 * La barre reprenait les cinq ecrans du desktop. Elle suit desormais la forme
 * du mockup : Accueil, Planning, [scan], Objectifs, Profil. Les quatre ecrans
 * qui en sortent — Bibliotheque, Recettes, Courses, Frigo — sont rassembles
 * sur l'Accueil, qui est leur SEUL point d'entree : voir `ACCES` dans
 * AccueilScreen.tsx avant d'y toucher.
 *
 * Cinq onglets tenaient. Le sixieme emplacement n'existe pas : le bouton de
 * scan mange la colonne centrale, et c'est ce qui a impose l'arbitrage.
 *
 * `kicker` est le surtitre affiche au-dessus du grand titre. Il ne paraphrase
 * pas le titre — il dit ce que le titre ne peut pas dire. Sa PRESENCE decide
 * aussi de deux choses : que l'ecran est un onglet, et donc que l'en-tete
 * s'efface au profit du grand titre dans la page.
 */
export const TABS: ReadonlyArray<{
  to: string
  icon: IconName
  label: string
  kicker: string
}> = [
  // Le surtitre de l'Accueil est remplace a l'affichage par la date du jour :
  // c'est la seule information que le titre « Aujourd'hui » ne porte pas.
  // Celui-ci ne sert donc qu'a marquer l'entree comme onglet.
  { to: '/accueil', icon: 'ui-home', label: 'Accueil', kicker: 'Aujourd’hui' },
  { to: '/planning', icon: 'ui-calendar', label: 'Planning', kicker: 'Ce qui est prévu' },
  // Le bouton de scan s'insere ICI, entre le 2e et le 3e onglet. Il n'est pas
  // dans cette liste : il ne mene pas a un endroit ou l'on reste, et l'y
  // mettre lui donnerait un surtitre et un grand titre qu'il n'a que faire.
  { to: '/objectifs', icon: 'ui-goal', label: 'Objectifs', kicker: 'Où j’en suis' },
  { to: '/profil', icon: 'ui-user', label: 'Profil', kicker: 'Réglages et compte' },
]

/** Le chemin du point d'entree de scan, au centre de la barre. */
const SCAN = '/scan'

/**
 * Titres de l'en-tete, testes DANS L'ORDRE : le premier motif qui accroche
 * gagne. Les vues de creation viennent donc avant les vues de detail, sinon
 * `/ingredients/nouveau` ne serait jamais reconnu comme une creation.
 *
 * Le segment est `[^/]+` et non `\d+` : les identifiants ne sont pas les seules
 * valeurs possibles, et un motif trop strict laissait « Prandia »
 * s'afficher au-dessus d'un formulaire de creation.
 */
const TITLES: Array<[RegExp, string]> = [
  [/^\/accueil$/, 'Aujourd’hui'],
  [/^\/planning$/, 'Ma semaine'],
  [/^\/planning\/[0-6]$/, 'Ma journée'],
  [/^\/objectifs\/reglages$/, 'Régler mes objectifs'],
  [/^\/objectifs$/, 'Mes objectifs'],
  [/^\/profil$/, 'Mon espace'],
  [/^\/scan$/, 'Scanner'],
  [/^\/ingredients\/nouveau$/, 'Nouvel ingrédient'],
  [/^\/ingredients\/[^/]+$/, 'Ingrédient'],
  [/^\/ingredients$/, 'Ingrédients'],
  [/^\/recettes\/[^/]+\/modifier$/, 'Modifier la recette'],
  [/^\/recettes\/importer$/, 'Importer une recette'],
  [/^\/recettes\/[^/]+$/, 'Recette'],
  [/^\/recettes$/, 'Recettes'],
  [/^\/courses$/, 'Liste de courses'],
  [/^\/frigo$/, 'Frigo & cellier'],
  [/^\/parametres\/icones$/, 'Jeu d’icônes'],
  [/^\/parametres\/rayons$/, 'Rayons'],
  [/^\/parametres\/mes-icones$/, 'Mes icônes'],
  [/^\/parametres\/notifications$/, 'Notifications'],
  [/^\/activite$/, 'Journal d’activité'],
]

/**
 * Les vues empilees : elles ont besoin d'un retour visible.
 *
 * Quatre ecrans ont REJOINT cette liste — Bibliotheque, Recettes, Courses et
 * Frigo. Ils etaient des onglets ; on y arrive desormais depuis l'Accueil, donc
 * on doit pouvoir en revenir. Sans cela, le seul chemin de retour serait le
 * geste systeme du navigateur, absent d'une PWA installee en plein ecran.
 */
const STACKED =
  /^\/(ingredients|recettes|courses|frigo|scan|activite)$|^\/(ingredients|recettes)\/[^/]+(\/modifier)?$|^\/planning\/[0-6]$|^\/objectifs\/reglages$|^\/parametres(\/(icones|rayons|mes-icones|notifications))?$/

/** L'alias `/semaine`, qui emporte sa chaine de requete vers `/planning`. */
function RedirigeVersPlanning() {
  const { search } = useLocation()
  return <Navigate to={{ pathname: '/planning', search }} replace />
}

export function App() {
  const { isDark, toggle } = useTheme()
  const me = useCurrentUser()
  const { pathname } = useLocation()
  const navigate = useNavigate()

  const title = TITLES.find(([re]) => re.test(pathname))?.[1] ?? 'Prandia'
  const isStacked = STACKED.test(pathname)
  // Le surtitre n'existe que pour les quatre onglets. Une vue empilee garde son
  // titre dans la barre, a cote du bouton retour qui a besoin d'un ancrage.
  const tab = TABS.find((t) => t.to === pathname)
  const kicker = tab === undefined ? undefined : tab.to === '/accueil' ? libelleDuJour() : tab.kicker

  return (
    // Le fournisseur enveloppe TOUT l'arbre : sans lui, `useToast()` retombe
    // sur un repli silencieux et chaque « Annuler » proposE apres une
    // suppression disparait sans que rien ne le signale.
    <ToastProvider>
      <div className="app">
        <header className={`app-header${kicker ? ' app-header--effacee' : ''}`}>
          {isStacked ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => void navigate(-1)}
              aria-label="Retour"
            >
              <Icon name="ui-chevron-left" size={22} strokeWidth={1.9} />
            </button>
          ) : (
            <span className="icon-button icon-button--spacer" aria-hidden="true" />
          )}

          <h1 className="app-header__title">{title}</h1>

          {/* La roue dentee a disparu : elle menait aux parametres, devenus
              l'onglet Profil, visible en permanence dans la barre. Un raccourci
              vers un onglet est un detour, pas un raccourci. */}
          <div className="app-header__actions">
            <button
              type="button"
              className="icon-button"
              onClick={toggle}
              aria-label={isDark ? 'Passer en thème clair' : 'Passer en thème sombre'}
            >
              <Icon name={isDark ? 'ui-sun' : 'ui-moon'} size={20} strokeWidth={1.7} />
            </button>

            {/* L'avatar du mockup. Il ne double pas l'onglet Profil : il dit
                QUI est connecte, ce qui compte dans un foyer ou le poids, la
                taille et les objectifs sont personnels — on n'ouvre pas les
                siens en croyant ouvrir ceux de l'autre. */}
            <NavLink to="/profil" className="avatar lien-surface" aria-label={`Mon espace — ${me.displayName}`}>
              {me.displayName.slice(0, 1).toUpperCase()}
            </NavLink>
          </div>
        </header>

        <main className="app-main">
          {/* Le titre de l'ecran, rendu UNE FOIS ici plutot que dans chacun
              des cinq ecrans : les cinq l'auraient recopie, et le sixieme
              l'aurait oublie. `aria-hidden` parce que le <h1> reste dans la
              barre — deux titres annonces pour une seule page tromperaient un
              lecteur d'ecran. */}
          {kicker && (
            <div className="hero" aria-hidden="true">
              <span className="hero__kicker">{kicker}</span>
              <span className="hero__title">{title}</span>
            </div>
          )}

          <Routes>
            {/* `/` REDIRIGE, il ne rend pas.
                Rendre un ecran ici donnait le bon contenu mais aucun onglet en
                surbrillance : les NavLink de la barre portent des chemins
                precis, et `/` ne correspond a aucun. Comme le manifeste PWA
                declare `start_url: '/'`, l'application installee s'ouvrait
                donc systematiquement sans onglet actif. `replace` evite de
                laisser la redirection dans l'historique, donc de casser le
                bouton Retour. */}
            <Route path="/" element={<Navigate to="/accueil" replace />} />
            <Route path="/accueil" element={<AccueilScreen />} />
            <Route path="/planning" element={<WeekScreen />} />
            {/* Le jour est un ECRAN et non un depliant : deux niveaux de
                cartes blanches imbriquees se lisaient comme un seul. */}
            <Route path="/planning/:jour" element={<DayScreen />} />
            <Route path="/objectifs" element={<ObjectifsScreen />} />
            <Route path="/objectifs/reglages" element={<ProfileScreen />} />
            <Route path="/profil" element={<SettingsScreen />} />
            <Route path="/scan" element={<ScanScreen />} />
            <Route path="/ingredients" element={<IngredientsScreen />} />
            {/* Un seul motif, `:id`, y compris pour « /ingredients/nouveau ».
                L'ecran reconnait lui-meme ce segment et ouvre un formulaire
                vide. Une route litterale separee paraissait plus explicite,
                mais elle ne fournit AUCUN parametre : l'ecran ne voyait plus
                « nouveau » et repondait « Ingrédient introuvable ». */}
            <Route path="/ingredients/:id" element={<IngredientDetailScreen />} />
            <Route path="/recettes" element={<Repertoire />} />
            {/* La LECTURE a l'adresse courte, l'editeur dessous : tous les
                liens du projet pointent deja ici, et les inverser ferait
                ouvrir un formulaire depuis le planning et l'accueil. */}
            <Route path="/recettes/importer" element={<ImportRecette />} />
            <Route path="/recettes/:id" element={<RecipeView />} />
            <Route path="/recettes/:id/modifier" element={<RecipeDetailScreen />} />
            <Route path="/courses" element={<ShoppingScreen />} />
            <Route path="/frigo" element={<PantryScreen />} />

            {/* ---------- Anciennes adresses ----------
                Elles ont pu etre mises en favori, partagees, ou rester dans
                l'historique d'une PWA deja installee — dont le `start_url`
                pointait sur `/`. Le precedent est `/diagnostic`, alias
                conserve depuis le deplacement de l'ecran de diagnostic.
                `replace` pour ne pas coincer le bouton retour sur la
                redirection. */}
            {/* `search` recopie a la main : `<Navigate to="/planning">` avec
                une simple chaine ecrase la localisation entiere et JETTE le
                `?semaine=…`. Un lien partage vers une semaine precise doit
                ouvrir cette semaine-la, pas la semaine courante. */}
            <Route path="/semaine" element={<RedirigeVersPlanning />} />
            <Route path="/parametres" element={<Navigate to="/profil" replace />} />
            <Route path="/parametres/profil" element={<Navigate to="/objectifs/reglages" replace />} />
            {/* Galerie du jeu d'icones : verifier un dessin sur l'appareil reel
                vaut mieux que sur un ecran de bureau, ou tout parait lisible. */}
            <Route path="/parametres/icones" element={<IconGalleryScreen />} />
            <Route path="/parametres/rayons" element={<RayonsScreen />} />
            <Route path="/parametres/mes-icones" element={<CustomIconsScreen />} />
            <Route path="/parametres/notifications" element={<NotificationsScreen />} />
            <Route path="/diagnostic" element={<Navigate to="/profil" replace />} />
            <Route path="/activite" element={<ActivityScreen />} />
            <Route
              path="*"
              element={
                <section className="screen">
                  <div className="card">
                    <h2 className="card__title">Page introuvable</h2>
                    <p className="card__lead">Cette adresse ne correspond à rien.</p>
                  </div>
                </section>
              }
            />
          </Routes>
        </main>

        {/* Quatre onglets, et le scan AU MILIEU — pas en cinquieme position.
            Il est coupe en deux par `slice` plutot que glisse dans TABS :
            un element de TABS porte un surtitre, un grand titre et un etat
            actif d'onglet, dont un declencheur d'action n'a que faire. */}
        <nav className="tabbar" aria-label="Navigation principale">
          {TABS.slice(0, 2).map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) => `tabbar__item lien-surface${isActive ? ' tabbar__item--active' : ''}`}
            >
              <span className="tabbar__icon">
                <Icon name={tab.icon} size={24} strokeWidth={1.7} />
              </span>
              <span className="tabbar__label">{tab.label}</span>
            </NavLink>
          ))}

          <NavLink
            to={SCAN}
            className={({ isActive }) => `tabbar__scan lien-surface${isActive ? ' tabbar__scan--active' : ''}`}
            aria-label="Scanner un code-barres"
          >
            <Icon name="ui-scan" size={26} strokeWidth={1.9} />
          </NavLink>

          {TABS.slice(2).map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) => `tabbar__item lien-surface${isActive ? ' tabbar__item--active' : ''}`}
            >
              <span className="tabbar__icon">
                <Icon name={tab.icon} size={24} strokeWidth={1.7} />
              </span>
              <span className="tabbar__label">{tab.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </ToastProvider>
  )
}
