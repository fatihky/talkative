// deno-fmt-ignore-file
// biome-ignore format: generated types do not need formatting
// prettier-ignore
import type { PathsForPages, GetConfigResponse, SearchCodecsForPages } from 'waku/router';

// prettier-ignore
import type { getConfig as File_AId_getConfig } from './pages/a/[id]';
// prettier-ignore
import type { getConfig as File_AuthLogin_getConfig } from './pages/auth/login';
// prettier-ignore
import type { getConfig as File_AuthRegister_getConfig } from './pages/auth/register';
// prettier-ignore
import type { getConfig as File_CSlug_getConfig } from './pages/c/[slug]';
// prettier-ignore
import type { getConfig as File_Decisions_getConfig } from './pages/decisions';
// prettier-ignore
import type { getConfig as File_DecisionsSlug_getConfig } from './pages/decisions/[slug]';
// prettier-ignore
import type { getConfig as File_FolderSlug_getConfig } from './pages/folder/[slug]';
// prettier-ignore
import type { getConfig as File_Index_getConfig } from './pages/index';
// prettier-ignore
import type { getConfig as File_NotesSlug_getConfig } from './pages/notes/[slug]';
// prettier-ignore
import type { getConfig as File_NotesIndex_getConfig } from './pages/notes/index';
// prettier-ignore
import type { getConfig as File_P_getConfig } from './pages/p';
// prettier-ignore
import type { getConfig as File_SettingsAccount_getConfig } from './pages/settings/account';
// prettier-ignore
import type { getConfig as File_SettingsAppearance_getConfig } from './pages/settings/appearance';
// prettier-ignore
import type { getConfig as File_SettingsArtifacts_getConfig } from './pages/settings/artifacts';
// prettier-ignore
import type { getConfig as File_SettingsIndex_getConfig } from './pages/settings/index';
// prettier-ignore
import type { getConfig as File_SettingsMemoriesId_getConfig } from './pages/settings/memories/[id]';
// prettier-ignore
import type { getConfig as File_SettingsMemoriesIndex_getConfig } from './pages/settings/memories/index';
// prettier-ignore
import type { getConfig as File_SettingsProviders_getConfig } from './pages/settings/providers';
// prettier-ignore
import type { getConfig as File_SettingsSite_getConfig } from './pages/settings/site';
// prettier-ignore
import type { getConfig as File_SettingsToolKeys_getConfig } from './pages/settings/tool-keys';
// prettier-ignore
import type { getConfig as File_SettingsTools_getConfig } from './pages/settings/tools';
// prettier-ignore
import type { getConfig as File_SettingsUsers_getConfig } from './pages/settings/users';

// prettier-ignore
type Page =
| ({ path: '/a/[id]' } & GetConfigResponse<typeof File_AId_getConfig>)
| { path: '/auth/login-form'; render: 'static' }
| ({ path: '/auth/login' } & GetConfigResponse<typeof File_AuthLogin_getConfig>)
| { path: '/auth/register-form'; render: 'static' }
| ({ path: '/auth/register' } & GetConfigResponse<typeof File_AuthRegister_getConfig>)
| ({ path: '/c/[slug]' } & GetConfigResponse<typeof File_CSlug_getConfig>)
| ({ path: '/decisions' } & GetConfigResponse<typeof File_Decisions_getConfig>)
| ({ path: '/decisions/[slug]' } & GetConfigResponse<typeof File_DecisionsSlug_getConfig>)
| ({ path: '/folder/[slug]' } & GetConfigResponse<typeof File_FolderSlug_getConfig>)
| ({ path: '/' } & GetConfigResponse<typeof File_Index_getConfig>)
| ({ path: '/notes/[slug]' } & GetConfigResponse<typeof File_NotesSlug_getConfig>)
| ({ path: '/notes' } & GetConfigResponse<typeof File_NotesIndex_getConfig>)
| ({ path: '/p' } & GetConfigResponse<typeof File_P_getConfig>)
| ({ path: '/settings/account' } & GetConfigResponse<typeof File_SettingsAccount_getConfig>)
| ({ path: '/settings/appearance' } & GetConfigResponse<typeof File_SettingsAppearance_getConfig>)
| ({ path: '/settings/artifacts' } & GetConfigResponse<typeof File_SettingsArtifacts_getConfig>)
| ({ path: '/settings' } & GetConfigResponse<typeof File_SettingsIndex_getConfig>)
| ({ path: '/settings/memories/[id]' } & GetConfigResponse<typeof File_SettingsMemoriesId_getConfig>)
| ({ path: '/settings/memories' } & GetConfigResponse<typeof File_SettingsMemoriesIndex_getConfig>)
| ({ path: '/settings/providers' } & GetConfigResponse<typeof File_SettingsProviders_getConfig>)
| ({ path: '/settings/site' } & GetConfigResponse<typeof File_SettingsSite_getConfig>)
| ({ path: '/settings/tool-keys' } & GetConfigResponse<typeof File_SettingsToolKeys_getConfig>)
| ({ path: '/settings/tools' } & GetConfigResponse<typeof File_SettingsTools_getConfig>)
| ({ path: '/settings/users' } & GetConfigResponse<typeof File_SettingsUsers_getConfig>);

// prettier-ignore
type Layout =
| { path: '/' }
| { path: '/auth' };

// prettier-ignore
declare module 'waku/router' {
  interface RouteConfig {
    paths: PathsForPages<Page>;
  }
  interface CreatePagesConfig {
    pages: Page;
    layouts: Layout;
  }
  interface SearchCodecsConfig extends SearchCodecsForPages<Page> {}
}
