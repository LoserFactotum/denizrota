#!/usr/bin/env python3
"""Run the app's actual C engine; check Xcode structure without claiming an iOS build."""
from pathlib import Path
import json
import plistlib
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]

def parse_openstep(text):
    # OpenStep property list reader for project structure validation.
    token_pattern = re.compile(r'\s+|//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|[{}()=;,]|[^\s{}()=;,]+', re.S)
    tokens = [t.group() for t in token_pattern.finditer(text)
              if not t.group().isspace() and not t.group().startswith(("//", "/*"))]
    i = 0
    def expect(token):
        nonlocal i
        assert tokens[i] == token, (i, tokens[i], token)
        i += 1
    def value():
        nonlocal i
        t = tokens[i]
        if t == "{":
            i += 1
            output = {}
            while tokens[i] != "}":
                key = value()
                expect("=")
                assert key not in output, f"Duplicate key: {key}"
                output[key] = value()
                expect(";")
            expect("}")
            return output
        if t == "(":
            i += 1
            output = []
            while tokens[i] != ")":
                output.append(value())
                if tokens[i] != ")": expect(",")
            expect(")")
            return output
        i += 1
        return json.loads(t) if t.startswith('"') else t
    parsed = value()
    assert i == len(tokens), "Trailing tokens"
    return parsed

project = parse_openstep((ROOT / "DenizRota.xcodeproj/project.pbxproj").read_text())
objects = project["objects"]
assert objects[project["rootObject"]]["isa"] == "PBXProject"
def check_references(value):
    if isinstance(value, dict):
        for item in value.values(): check_references(item)
    elif isinstance(value, list):
        for item in value: check_references(item)
    elif re.fullmatch(r"[A-F0-9]{24}", value):
        assert value in objects, f"Dangling reference: {value}"
check_references(objects)
files = {key: item for key, item in objects.items() if item.get("isa") == "PBXFileReference"}
for item in files.values():
    if item.get("sourceTree") == "<group>":
        assert (ROOT / item["path"]).is_file(), f"Missing file: {item['path']}"
phase = next(item for item in objects.values() if item.get("isa") == "PBXSourcesBuildPhase")
compiled = {files[objects[key]["fileRef"]]["path"] for key in phase["files"]}
expected = {p.relative_to(ROOT).as_posix() for p in (ROOT / "DenizRota").rglob("*") if p.suffix in (".swift", ".c")}
assert compiled == expected, (compiled, expected)
for p in list((ROOT / "DenizRota").glob("*.plist")) + list((ROOT / "DenizRota").glob("*.xcprivacy")):
    plistlib.loads(p.read_bytes())
scheme = ET.parse(ROOT / "DenizRota.xcodeproj/xcshareddata/xcschemes/DenizRota.xcscheme")
for ref in scheme.iter("BuildableReference"):
    assert objects[ref.attrib["BlueprintIdentifier"]]["isa"] == "PBXNativeTarget"
print(f"PASS: Xcode project structure, {len(compiled)} source memberships, plists and shared scheme")

compiler = shutil.which("cc")
assert compiler, "A C compiler is needed (Xcode Command Line Tools on Mac)."
with tempfile.TemporaryDirectory(prefix="denizrota-tests-") as temp:
    binary = Path(temp) / "navigation-tests"
    subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-O2",
                    "-I", str(ROOT / "DenizRota/Core"), str(ROOT / "DenizRota/Core/NavigationMath.c"),
                    str(ROOT / "tests/NavigationMathTests.c"), "-lm", "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
    router_binary = Path(temp) / "router-tests"
    subprocess.run([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-O2",
                    "-I", str(ROOT / "DenizRota/Core"), str(ROOT / "DenizRota/Core/NavigationMath.c"),
                    str(ROOT / "DenizRota/Core/AutoRouter.c"), str(ROOT / "tests/AutoRouterTests.c"),
                    "-lm", "-o", str(router_binary)], check=True)
    subprocess.run([str(router_binary)], check=True)
subprocess.run([__import__("sys").executable, str(ROOT / "tests/MarineGridTests.py")], check=True)
if not shutil.which("xcodebuild"):
    print("NOT RUN: Swift/iOS build, simulator, UI, permissions, GPS and live map integration (Xcode unavailable)")
else:
    print("NEXT: xcodebuild -project DenizRota.xcodeproj -scheme DenizRota -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build")
