Pod::Spec.new do |s|
  s.name = 'T3VoiceMode'
  s.version = '1.0.0'
  s.summary = 'On-device listening and speech for T3 Code voice mode.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '18.0'
  s.swift_version = '5.9'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AVFoundation', 'CoreML'

  # CocoaPods trunk stops at FluidAudio 0.7.8, so it comes from GitHub through React Native's SwiftPM hook.
  if defined?(spm_dependency)
    spm_dependency(s,
      url: 'https://github.com/FluidInference/FluidAudio.git',
      requirement: { kind: 'exactVersion', version: '0.18.4' },
      products: ['FluidAudio']
    )
  end
end
