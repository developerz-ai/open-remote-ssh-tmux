import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import Log from './common/logger';

let vscodeProductJson: Record<string, unknown>;

async function getVSCodeProductJson() {
    if (!vscodeProductJson) {
        const productJsonStr = await fs.promises.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8');
        vscodeProductJson = JSON.parse(productJsonStr);
    }

    return vscodeProductJson;
}

export type ServerVersion = 'closest' | 'latest' | 'match' | string;
export type ServerValidation = 'force' | 'skip' | 'strict';

export type IServerConfig = {
    version: string;
    commit: string;
    quality: string;
    release: string;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate?: string;
    serverValidation: ServerValidation;
};

const SERVER_VALIDATION_VALUES: readonly ServerValidation[] = ['force', 'skip', 'strict'];

// `vscode.workspace.getConfiguration(...).get<T>(...)` only casts, it never validates —
// a user can still hand-edit settings.json to a typo'd/mis-cased value (e.g. 'Skip').
// Left unchecked, that value would flow straight into `serverValidation === 'skip'`/`'force'`
// checks in serverSetup.ts, silently matching neither and behaving like 'strict' with no
// indication anything was wrong. Normalize against the allowed literals here and log unknowns.
export function normalizeServerValidation(raw: string, logger: Log): ServerValidation {
    if ((SERVER_VALIDATION_VALUES as readonly string[]).includes(raw)) {
        return raw as ServerValidation;
    }

    logger.info(`Unrecognized remote.SSH.serverValidation value "${raw}", falling back to "strict"`);
    return 'strict';
}

export async function getVSCodeServerConfig(logger: Log): Promise<IServerConfig> {
    const productJson = await getVSCodeProductJson();

    const customServerBinaryName = vscode.workspace.getConfiguration('remote.SSH').get<string>('serverBinaryName', '');
    const rawServerValidation = vscode.workspace.getConfiguration('remote.SSH').get<string>('serverValidation', 'strict');
    const serverValidation = normalizeServerValidation(rawServerValidation, logger);

    return {
        version: vscode.version.replace('-insider',''),
        commit: productJson.commit as string,
        quality: productJson.quality as string,
        release: productJson.release as string || '',
        serverApplicationName: customServerBinaryName || productJson.serverApplicationName as string,
        serverDataFolderName: productJson.serverDataFolderName as string,
        serverDownloadUrlTemplate: productJson.serverDownloadUrlTemplate as string,
        serverValidation,
    };
}
