// src/extension/config/fileFilters.ts

/**
 * Defines a language's file filtering rules.
 */
export interface LanguageFilter {
    // Included file extensions
    include: string[];
    // Specific files or patterns to explicitly exclude
    exclude: string[];
}

/**
 * Generic exclusion list, applicable to all languages and projects.
 */
export const GENERIC_EXCLUDE = [
    'node_modules',
    'dist',
    'out',
    'build',
    'target', // Common for Java (Maven/Gradle)
    'bin',
    'vendor',
    '.git',
    '.svn',
    '.hg',
    '__pycache__',
    '.vscode',
    '.idea',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'go.sum',
    '.DS_Store'
];

/**
 * Language-specific filtering rules.
 */
export const languageFilters: Record<string, LanguageFilter> = {
    typescript: {
        include: ['.ts', '.tsx'],
        exclude: ['.d.ts', '.spec.ts', '.test.ts'],
    },
    javascript: {
        include: ['.js', '.jsx'],
        exclude: ['.spec.js', '.test.js'],
    },
    python: {
        include: ['.py'],
        exclude: [],
    },
    go: {
        include: ['.go'],
        exclude: ['_test.go'],
    },
    // highlight-start
    java: {
        include: ['.java'],
        // Java testing is typically directory-based (src/test/java),
        // which is handled by module selection rather than file-level filtering.
        exclude: [], 
    },
    c: {
        // Headers (.h) are crucial for understanding interfaces and must be included.
        include: ['.c', '.h'],
        exclude: [],
    },
    cpp: { // Using 'cpp' as the key for C++
        // C++ has various extensions for source and header files.
        // Including the most common ones. Headers are critical.
        include: ['.cpp', '.hpp', '.cc', '.cxx', '.h'],
        exclude: [],
    },
    // highlight-end
    unknown: { // Default rule when language isn't identified
        include: [
            '.ts', '.tsx', '.js', '.jsx', '.py', '.go', 
            // highlight-start
            '.java', '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', 
            // highlight-end
            '.cs', '.rb', '.php', '.rs'
        ],
        exclude: ['.spec.ts', '.test.ts', '.spec.js', '.test.js', '_test.go'],
    }
};