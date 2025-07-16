# Atlas Electron Installer

A professional, cross-platform installer for Atlas CLI built with Electron.

## Features

✅ **Cross-Platform**: Works on macOS and Windows (Linux uses native .deb/.rpm packages)\
✅ **Professional UI**: Modern, responsive interface with dark mode support\
✅ **License Agreement**: Centralized EULA.txt integration with required acceptance\
✅ **API Key Management**: Secure API key collection and validation\
✅ **Real Installation**: Actually creates files and configures system\
✅ **Progress Tracking**: Visual feedback with installation logs\
✅ **Service Management**: Automatic daemon/service installation and startup\
✅ **Standalone Binary**: No dependencies required for end users

## Built Artifacts

### macOS

- **AtlasInstaller.app** - Native macOS app bundle (double-click to run)
- **AtlasInstaller-VERSION-darwin-ARCH.zip** - ZIP installer for distribution

### Windows (build with `npm run build:win`)

- **Atlas Installer 1.0.0.exe** - Windows portable installer

### Linux

**Note**: Linux no longer uses the Electron installer. Native packages are built instead:

- **atlas_VERSION_amd64.deb** - Debian/Ubuntu package
- **atlas-VERSION.x86_64.rpm** - RedHat/Fedora package

## Installation Flow

1. **Welcome Screen** - Introduction to Atlas with feature overview
2. **License Agreement** - EULA loaded from centralized EULA.txt file with required acceptance
3. **API Key Configuration** - Optional Anthropic API key input with validation (sk-ant-* format)
4. **Installation Process** - Real-time progress with detailed logging:
   - Create Atlas directory (`~/.atlas/`)
   - Install Atlas binary to system location
   - Configure API key (if provided)
   - Set up PATH environment
   - Start Atlas service/daemon
5. **Completion** - Success confirmation with service status and next steps

## Technical Implementation

### Frontend

- **HTML/CSS/JavaScript** - Modern web technologies
- **Gradient UI** - Professional design with Atlas branding
- **Responsive Layout** - Adapts to different screen sizes
- **Dark Mode Support** - Automatically adapts to system theme

### Backend (Electron Main Process)

- **File System Operations** - Creates `~/.atlas/.env` with API key
- **Cross-Platform Paths** - Handles Windows/macOS differences
- **Security** - Sandboxed renderer with IPC communication
- **Binary Installation** - Installs real Atlas CLI binary to system
- **Service Management** - Automatically installs and starts Atlas service (Windows scheduled
  task/macOS launchd)
- **EULA Loading** - Reads license from centralized EULA.txt file

### Cross-Platform Compatibility

- **macOS**: ZIP distribution with app bundle
- **Windows**: Portable executable installer
- **Linux**: Uses native package managers (.deb/.rpm) instead of Electron installer

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

| Feature                    | PKG Installer      | Electron Installer          |
| -------------------------- | ------------------ | --------------------------- |
| **Platform Support**       | macOS only         | Windows, macOS              |
| **API Key Input**          | ❌ Not supported   | ✅ Native input field       |
| **License Display**        | Basic HTML         | ✅ EULA.txt with acceptance |
| **Progress Feedback**      | Limited            | ✅ Real-time with logs      |
| **UI Customization**       | Very limited       | ✅ Full control             |
| **Dark Mode**              | Broken             | ✅ Native support           |
| **Service Management**     | ❌ Not supported   | ✅ Automatic service setup  |
| **Installation Size**      | ~1MB               | ~100MB                      |
| **Development Complexity** | High (Apple tools) | Medium (web tech)           |

## File Structure

```
tools/atlas-installer/
├── main.js              # Electron main process
├── preload.js           # IPC bridge (secure)
├── renderer.js          # Frontend application logic
├── index.html           # UI structure with CSS variables
├── styles.css           # CSS variable-based design system
├── reset.css            # CSS reset
├── package.json         # Build configuration
├── logo.png             # Tempest logo
├── icons/               # Platform-specific icons
│   ├── icon.icns        # macOS icon
│   ├── icon.ico         # Windows icon
│   └── icon.png         # Linux icon
├── atlas-binary/        # Runtime atlas binary
│   └── atlas            # Copied during build
├── EULA.txt             # Centralized license (linked during build)
└── dist/                # Build outputs
    ├── AtlasInstaller-VERSION-darwin-ARCH.zip
    └── Atlas Installer VERSION.exe
```

## Real Installation Features

- ✅ **Creates `~/.atlas` directory**
- ✅ **Saves API key to `~/.atlas/.env`**
- ✅ **Sets proper file permissions (600)**
- ✅ **Cross-platform path handling**
- ✅ **Installs real Atlas binary to system locations**
- ✅ **PATH configuration preparation**
- ✅ **Automatic service management** (installs and starts system service)
- ✅ **Service status verification and error handling**

## Service Management Feature

The installer now automatically manages the Atlas service as the final installation step:

### Service Management Logic

1. **API Key Check**: Verifies if API key is available (entered or existing)
2. **Binary Check**: Confirms Atlas binary was successfully installed
3. **Service Installation**:
   - **Windows**: Creates scheduled task for system startup
   - **macOS**: Installs launchd service
4. **Service Start**: Attempts to start the service immediately
5. **Error Handling**: Graceful fallback with user guidance if service management fails

### Cross-Platform Implementation

- **Binary Detection**: Automatically locates Atlas binary at:
  - **Windows**: `%LOCALAPPDATA%\Atlas\atlas.exe`
  - **macOS**: `/usr/local/bin/atlas`
- **Service Type**:
  - **Windows**: Scheduled task running at system startup
  - **macOS**: LaunchAgent for user session
- **Environment Setup**: Loads configuration from `~/.atlas/.env`

### Error Recovery

- **Missing API Key**: Skip service start if no API key configured
- **Missing Binary**: Clear error message if Atlas binary not found
- **Service Failure**: Installation continues with warning and manual guidance
- **Admin Rights**: Graceful handling when administrator access not available

### Linux Native Packages

Linux systems use native package managers instead of the Electron installer:

#### Debian/Ubuntu (.deb)

- **Service**: systemd service unit (`atlas.service`)
- **User**: Dedicated `atlas` system user
- **Paths**:
  - Config: `/etc/atlas/env`
  - Data: `/var/lib/atlas`
  - Logs: `/var/log/atlas`
- **Installation**: Interactive debconf for EULA and API key

#### RedHat/Fedora (.rpm)

- **Service**: systemd service unit (`atlas.service`)
- **User**: Dedicated `atlas` system user
- **Paths**: Same as Debian packages
- **Installation**: Post-install script configuration

This installer provides a professional, native experience on each platform while maintaining
consistent functionality across Windows, macOS, and Linux systems.
