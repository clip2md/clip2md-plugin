export class App {}
export class ItemView {
    addAction() {
        throw new Error('addAction must be mocked by the test');
    }
}
export class MarkdownView extends ItemView {}
export class FuzzySuggestModal {}
export class Modal {}
export class Notice {}
export class PluginSettingTab {}
export class Setting {}
export class SettingPage {}
export class TAbstractFile {}
export class TFile {}
export class TFolder {}
export class Vault {}
export const addIcon = () => undefined;
export const requestUrl = () => {
    throw new Error('requestUrl must be mocked by the test');
};
