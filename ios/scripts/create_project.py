#!/usr/bin/env python3
"""Regenerate the committed Xcode project. Python stdlib only; no download."""
from pathlib import Path
import hashlib
import json
import plistlib

ROOT = Path(__file__).resolve().parents[1]

def identifier(label):
    return hashlib.sha256(label.encode()).hexdigest()[:24].upper()

def q(value):
    return json.dumps(str(value), ensure_ascii=False)

objects = []
def add(label, content):
    key = identifier(label)
    objects.append(f"\t\t{key} = {{ {content} }};")
    return key

sources = sorted((ROOT / "DenizRota").rglob("*.swift")) + sorted((ROOT / "DenizRota/Core").glob("*.c"))
headers = sorted((ROOT / "DenizRota/Core").glob("*.h"))
file_refs, build_refs = [], []
for path in sources + headers:
    relative = path.relative_to(ROOT).as_posix()
    kind = {".swift": "sourcecode.swift", ".c": "sourcecode.c.c", ".h": "sourcecode.c.h"}[path.suffix]
    ref = add("file:" + relative,
              f'isa = PBXFileReference; lastKnownFileType = {kind}; path = {q(relative)}; sourceTree = "<group>";')
    file_refs.append(ref)
    if path in sources:
        build_refs.append(add("build:" + relative, f"isa = PBXBuildFile; fileRef = {ref};"))

resource_builds = []
for name, kind in [("Info.plist", "text.plist.xml"), ("PrivacyInfo.xcprivacy", "text.xml")]:
    ref = add("file:" + name, f'isa = PBXFileReference; lastKnownFileType = {kind}; path = "DenizRota/{name}"; sourceTree = "<group>";')
    file_refs.append(ref)
    if name != "Info.plist":
        resource_builds.append(add("build:" + name, f"isa = PBXBuildFile; fileRef = {ref};"))

product = add("product", 'isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = DenizRota.app; sourceTree = BUILT_PRODUCTS_DIR;')
source_group = add("source-group", 'isa = PBXGroup; name = DenizRota; sourceTree = "<group>"; children = (' + ",".join(file_refs) + ');')
products_group = add("products-group", f'isa = PBXGroup; name = Products; sourceTree = "<group>"; children = ({product});')
main_group = add("main-group", f'isa = PBXGroup; sourceTree = "<group>"; children = ({source_group}, {products_group});')
source_phase = add("sources", "isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (" + ",".join(build_refs) + "); runOnlyForDeploymentPostprocessing = 0;")
framework_phase = add("frameworks", "isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
resource_phase = add("resources", "isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (" + ",".join(resource_builds) + "); runOnlyForDeploymentPostprocessing = 0;")

project_configs, target_configs = [], []
for name in ("Debug", "Release"):
    project_settings = {
        "CLANG_ENABLE_MODULES": "YES", "CLANG_ENABLE_OBJC_ARC": "YES",
        "GCC_C_LANGUAGE_STANDARD": "c11", "GCC_WARN_64_TO_32_BIT_CONVERSION": "YES",
        "GCC_WARN_UNDECLARED_SELECTOR": "YES", "GCC_WARN_UNUSED_VARIABLE": "YES",
        "SDKROOT": "iphoneos", "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
        "SWIFT_VERSION": "5.0", "SWIFT_STRICT_CONCURRENCY": "minimal",
        "DEBUG_INFORMATION_FORMAT": "dwarf" if name == "Debug" else "dwarf-with-dsym",
        "GCC_OPTIMIZATION_LEVEL": "0" if name == "Debug" else "s",
        "SWIFT_OPTIMIZATION_LEVEL": "-Onone" if name == "Debug" else "-O",
        "ENABLE_TESTABILITY": "YES" if name == "Debug" else "NO",
    }
    if name == "Debug":
        project_settings["SWIFT_ACTIVE_COMPILATION_CONDITIONS"] = "DEBUG"
        project_settings["ONLY_ACTIVE_ARCH"] = "YES"
    target_settings = {
        "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "com.denizrota.app",
        "CODE_SIGN_STYLE": "Automatic", "DEVELOPMENT_TEAM": "",
        "GENERATE_INFOPLIST_FILE": "NO", "INFOPLIST_FILE": "DenizRota/Info.plist",
        "SWIFT_OBJC_BRIDGING_HEADER": "DenizRota/Core/DenizRota-Bridging-Header.h",
        "HEADER_SEARCH_PATHS": "$(SRCROOT)/DenizRota/Core", "TARGETED_DEVICE_FAMILY": "1,2",
        "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator", "SUPPORTS_MACCATALYST": "NO",
        "CURRENT_PROJECT_VERSION": "2", "MARKETING_VERSION": "0.2.0",
        "OTHER_LDFLAGS": "$(inherited) -lz",
        "LD_RUNPATH_SEARCH_PATHS": "$(inherited) @executable_path/Frameworks",
        "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
    }
    for category, settings, destination in [("project", project_settings, project_configs), ("target", target_settings, target_configs)]:
        body = " ".join(f"{key} = {q(value)};" for key, value in settings.items())
        destination.append(add(f"{category}:{name}", f"isa = XCBuildConfiguration; buildSettings = {{ {body} }}; name = {name};"))

def config_list(label, refs):
    return add(label, "isa = XCConfigurationList; buildConfigurations = (" + ",".join(refs) + "); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")

target_config = config_list("target-configs", target_configs)
project_config = config_list("project-configs", project_configs)
target = add("target", f'isa = PBXNativeTarget; buildConfigurationList = {target_config}; buildPhases = ({source_phase}, {framework_phase}, {resource_phase}); buildRules = (); dependencies = (); name = DenizRota; productName = DenizRota; productReference = {product}; productType = "com.apple.product-type.application";')
project = add("project", f'isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 1600; TargetAttributes = {{ {target} = {{ CreatedOnToolsVersion = 16.0; }}; }}; }}; buildConfigurationList = {project_config}; compatibilityVersion = "Xcode 14.0"; developmentRegion = tr; hasScannedForEncodings = 0; knownRegions = (tr, en, Base); mainGroup = {main_group}; productRefGroup = {products_group}; projectDirPath = ""; projectRoot = ""; targets = ({target});')
project_dir = ROOT / "DenizRota.xcodeproj"
project_dir.mkdir(exist_ok=True)
(project_dir / "project.pbxproj").write_text("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n" + "\n".join(objects) + f"\n\t}};\n\trootObject = {project};\n}}\n")
schemes = project_dir / "xcshareddata/xcschemes"
schemes.mkdir(parents=True, exist_ok=True)
reference = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{target}" BuildableName="DenizRota.app" BlueprintName="DenizRota" ReferencedContainer="container:DenizRota.xcodeproj"/>'
(schemes / "DenizRota.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{reference}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{reference}</BuildableProductRunnable></ProfileAction>
  <AnalyzeAction buildConfiguration="Debug"/>
  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
''')

info = {
    "CFBundleDevelopmentRegion": "tr", "CFBundleDisplayName": "DenizRota",
    "CFBundleExecutable": "$(EXECUTABLE_NAME)", "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
    "CFBundleInfoDictionaryVersion": "6.0", "CFBundleName": "$(PRODUCT_NAME)",
    "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "$(MARKETING_VERSION)",
    "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)", "LSRequiresIPhoneOS": True,
    "NSLocationWhenInUseUsageDescription": "Haritada konumunu, tekne hızını ve rotanın kalan süresini göstermek için konum izni gerekiyor.",
    "UIApplicationSceneManifest": {"UIApplicationSupportsMultipleScenes": False},
    "UILaunchScreen": {},
    "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
    "UISupportedInterfaceOrientations~ipad": ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"],
    "UIFileSharingEnabled": True, "LSSupportsOpeningDocumentsInPlace": True,
    "UTExportedTypeDeclarations": [{"UTTypeIdentifier": "com.denizrota.route.gpx",
        "UTTypeDescription": "GPX route", "UTTypeConformsTo": ["public.xml"],
        "UTTypeTagSpecification": {"public.filename-extension": ["gpx"], "public.mime-type": "application/gpx+xml"}}],
}
(ROOT / "DenizRota/Info.plist").write_bytes(plistlib.dumps(info))
privacy = {"NSPrivacyTracking": False, "NSPrivacyTrackingDomains": [], "NSPrivacyCollectedDataTypes": [],
           "NSPrivacyAccessedAPITypes": [{"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
                                          "NSPrivacyAccessedAPITypeReasons": ["C617.1"]}]}
(ROOT / "DenizRota/PrivacyInfo.xcprivacy").write_bytes(plistlib.dumps(privacy))
print(f"Generated Xcode project: {len(sources)} source files, iOS 17+")
