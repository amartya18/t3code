Pod::Spec.new do |s|
  s.name = 'T3Diagnostics'
  s.version = '1.0.0'
  s.summary = 'Keeps iOS crash and diagnostic reports until the app uploads them.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'MetricKit'
end
