Pod::Spec.new do |s|
  s.name           = 'SiteAudio'
  s.version        = '1.0.0'
  s.summary        = 'SiteNote microphone and PCM playback'
  s.description    = 'On-device capture, playback, and local record writes for SiteNote.'
  s.license        = { :type => 'UNLICENSED' }
  s.author         = 'SiteNote'
  s.homepage       = 'https://example.invalid/sitenote'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.swift_version = '5.9'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift}'
end
