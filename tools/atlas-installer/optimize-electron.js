#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Aggressive Electron Framework size optimization script
 * Removes unnecessary components to reduce the 255MB Electron Framework
 */

function optimizeElectronFramework(appPath) {
    console.log('Starting aggressive Electron Framework optimization...');
    
    // Check if this is a macOS app bundle (.app directory)
    if (!appPath.endsWith('.app') || !fs.existsSync(appPath)) {
        console.log('Not a macOS app bundle or path does not exist, skipping optimization');
        return;
    }
    
    const frameworkPath = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework');
    const versionsPath = path.join(frameworkPath, 'Versions', 'A');
    const resourcesPath = path.join(versionsPath, 'Resources');
    
    if (!fs.existsSync(frameworkPath)) {
        console.log('Electron Framework not found, skipping optimization (likely not macOS)');
        return;
    }
    
    let savedBytes = 0;
    
    // Remove unnecessary locale files (saves ~59MB)
    const localesPath = path.join(resourcesPath, 'locales');
    if (fs.existsSync(localesPath)) {
        const localeFiles = fs.readdirSync(localesPath);
        const keepLocales = ['en-US.pak']; // Only keep English
        
        for (const file of localeFiles) {
            if (!keepLocales.includes(file)) {
                const filePath = path.join(localesPath, file);
                const stats = fs.statSync(filePath);
                savedBytes += stats.size;
                fs.unlinkSync(filePath);
            }
        }
        console.log(`Removed ${localeFiles.length - keepLocales.length} locale files`);
    }
    
    // Remove unnecessary helper applications
    const helperApps = [
        'Electron Helper (GPU).app',
        'Electron Helper (Plugin).app', 
        'Electron Helper (Renderer).app'
    ];
    
    for (const helperApp of helperApps) {
        const helperPath = path.join(appPath, 'Contents', 'Frameworks', helperApp);
        if (fs.existsSync(helperPath)) {
            const stats = getDirectorySize(helperPath);
            savedBytes += stats;
            execSync(`rm -rf "${helperPath}"`);
            console.log(`Removed ${helperApp}`);
        }
    }
    
    // Remove debug and development files
    const debugFiles = [
        path.join(resourcesPath, 'inspector'),
        path.join(resourcesPath, 'v8_context_snapshot.bin'),
        path.join(resourcesPath, 'snapshot_blob.bin')
    ];
    
    for (const debugFile of debugFiles) {
        if (fs.existsSync(debugFile)) {
            const stats = fs.statSync(debugFile);
            savedBytes += stats.size;
            fs.unlinkSync(debugFile);
            console.log(`Removed debug file: ${path.basename(debugFile)}`);
        }
    }
    
    // Remove unnecessary Chrome DevTools resources
    const devToolsPath = path.join(resourcesPath, 'inspector');
    if (fs.existsSync(devToolsPath)) {
        const stats = getDirectorySize(devToolsPath);
        savedBytes += stats;
        execSync(`rm -rf "${devToolsPath}"`);
        console.log('Removed Chrome DevTools resources');
    }
    
    console.log(`Optimization complete. Saved approximately ${Math.round(savedBytes / 1024 / 1024)}MB`);
}

function getDirectorySize(dirPath) {
    let totalSize = 0;
    
    function calculateSize(itemPath) {
        const stats = fs.statSync(itemPath);
        if (stats.isDirectory()) {
            const items = fs.readdirSync(itemPath);
            for (const item of items) {
                calculateSize(path.join(itemPath, item));
            }
        } else {
            totalSize += stats.size;
        }
    }
    
    try {
        calculateSize(dirPath);
    } catch (error) {
        console.log(`Error calculating size for ${dirPath}: ${error.message}`);
    }
    
    return totalSize;
}

// Run optimization if called directly
if (require.main === module) {
    const appPath = process.argv[2];
    if (!appPath) {
        console.error('Usage: node optimize-electron.js <app-path>');
        process.exit(1);
    }
    
    optimizeElectronFramework(appPath);
}

module.exports = { optimizeElectronFramework };