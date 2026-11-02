// Généré par install.sh (modèle : libexec/mempalace-plugin.ts.tpl) : charge le plugin MemPalace installé dans __ROOT__.
// Il fixe MEMPALACE_ADAPTER_PYTHON (le Python du venv qui contient « mempalace ») AVANT de charger le plugin, sauf si tu
// l'as déjà défini toi-même. Sans ça, le plugin retombe sur le python3 du système et échoue avec
// « ModuleNotFoundError: No module named 'mempalace' » dès que le shell de lancement n'a pas la variable.
process.env.MEMPALACE_ADAPTER_PYTHON ||= "__PYTHON__"
const plugin = await import("__ENTRY__")
export default plugin.default
