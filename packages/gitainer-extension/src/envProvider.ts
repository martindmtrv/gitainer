import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class EnvProvider {
    async getHydratedContent(document: vscode.TextDocument): Promise<string> {
        const content = document.getText();
        const envVars = this.extractEnvVars(content);
        if (envVars.length === 0) {
            return "No environment variables found.";
        }

        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const resolvedVars: Record<string, string | undefined> = {};

        if (folder) {
            const envPath = path.join(folder.uri.fsPath, '.env');
            if (fs.existsSync(envPath)) {
                const envContent = fs.readFileSync(envPath, 'utf8');
                const envMap = this.parseEnv(envContent);
                envVars.forEach(v => {
                    resolvedVars[v] = envMap[v];
                });
            }
        }

        let output = "# Environment Variables Preview\n\n";
        output += "| Variable | Value | Status |\n";
        output += "| --- | --- | --- |\n";
        envVars.forEach(v => {
            const val = resolvedVars[v];
            output += `| \`${v}\` | \`${val ?? ''}\` | ${val !== undefined ? '✅ Resolved' : '❌ Not Found'} |\n`;
        });

        return output;
    }

    private extractEnvVars(content: string): string[] {
        const regex = /\$(?:([a-zA-Z_][a-zA-Z0-9_]*)|{([a-zA-Z_][a-zA-Z0-9_]*)})/g;
        const vars = new Set<string>();
        let match;
        while ((match = regex.exec(content)) !== null) {
            vars.add(match[1] || match[2]);
        }
        return Array.from(vars);
    }

    private parseEnv(content: string): Record<string, string> {
        const lines = content.split('\n');
        const envMap: Record<string, string> = {};
        lines.forEach(line => {
            const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (m) {
                let val = m[2] || '';
                if (val.length > 0 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
                    val = val.replace(/\\n/gm, '\n');
                }
                envMap[m[1]] = val.replace(/(^['"]|['"]$)/g, '');
            }
        });
        return envMap;
    }
}
