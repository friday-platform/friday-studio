# Atlas Electron Installer

A professional, cross-platform installer for Atlas CLI built with Electron.

## Features

✅ **Cross-Platform**: Works on macOS, Windows, and Linux  
✅ **Professional UI**: Modern, responsive interface with dark mode support  
✅ **License Agreement**: Full EULA integration with required acceptance  
✅ **API Key Management**: Secure API key collection and storage  
✅ **Real Installation**: Actually creates files and configures system  
✅ **Progress Tracking**: Visual feedback with installation logs  
✅ **Standalone Binary**: No dependencies required for end users  

## Built Artifacts

### macOS
- **AtlasInstaller.app** - Native macOS app bundle (double-click to run)
- **AtlasInstaller-VERSION-darwin-ARCH.zip** - ZIP installer for distribution

### Windows (build with `npm run build:win`)
- **Atlas Installer Setup 1.0.0.exe** - Windows NSIS installer

### Linux (build with `npm run build:linux`)
- **Atlas Installer-1.0.0.AppImage** - Portable Linux application

## Installation Flow

1. **Welcome Screen** - Introduction to Atlas with feature overview
2. **License Agreement** - Full Tempest Labs EULA with required acceptance
3. **API Key Configuration** - Optional Anthropic API key input with validation
4. **Installation Process** - Real-time progress with detailed logging
5. **Completion** - Success confirmation with next steps

## Technical Implementation

### Frontend
- **HTML/CSS/JavaScript** - Modern web technologies
- **Gradient UI** - Professional design with Atlas branding
- **Responsive Layout** - Adapts to different screen sizes
- **Dark Mode Support** - Automatically adapts to system theme

### Backend (Electron Main Process)
- **File System Operations** - Creates `~/.atlas/.env` with API key
- **Cross-Platform Paths** - Handles Windows/macOS/Linux differences  
- **Security** - Sandboxed renderer with IPC communication
- **Binary Installation** - Installs real Atlas CLI binary to system

### Cross-Platform Compatibility
- **macOS**: ZIP distribution with app bundle
- **Windows**: NSIS installer with registry integration
- **Linux**: AppImage for universal compatibility

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build for current platform
npm run build

# Build for specific platforms
npm run build:mac
npm run build:win
npm run build:linux

# Build for all platforms
npm run build:all
```

## Comparison with PKG Installer

| Feature | PKG Installer | Electron Installer |
|---------|---------------|-------------------|
| **Platform Support** | macOS only | Windows, macOS, Linux |
| **API Key Input** | ❌ Not supported | ✅ Native input field |
| **License Display** | Basic HTML | ✅ Scrollable with acceptance |
| **Progress Feedback** | Limited | ✅ Real-time with logs |
| **UI Customization** | Very limited | ✅ Full control |
| **Dark Mode** | Broken | ✅ Native support |
| **Installation Size** | ~1MB | ~100MB |
| **Development Complexity** | High (Apple tools) | Medium (web tech) |

## File Structure

```
tools/atlas-installer/
├── main.js              # Electron main process
├── preload.js           # IPC bridge (secure)
├── renderer.js          # Frontend application logic
├── index.html           # UI structure
├── styles.css           # Professional styling
├── package.json         # Build configuration
├── logo.png             # Tempest logo
├── icons/               # Platform-specific icons
│   ├── icon.icns        # macOS icon
│   ├── icon.ico         # Windows icon
│   └── icon.png         # Linux icon
├── atlas-binary/        # Runtime atlas binary
│   └── atlas            # Copied during build
└── dist/               # Build outputs
    ├── AtlasInstaller-VERSION-darwin-ARCH.zip
    ├── Atlas Installer Setup VERSION.exe
    └── Atlas Installer-VERSION.AppImage
```

## Real Installation Features

- ✅ **Creates `~/.atlas` directory**
- ✅ **Saves API key to `~/.atlas/.env`**  
- ✅ **Sets proper file permissions (600)**
- ✅ **Cross-platform path handling**
- ✅ **Installs real Atlas binary to system locations**
- ✅ **PATH configuration preparation**

This Electron installer provides a professional, cross-platform alternative to platform-specific installers while maintaining the same functionality and user experience across all operating systems.