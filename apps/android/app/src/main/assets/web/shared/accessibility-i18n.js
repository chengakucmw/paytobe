(function () {
  const STORAGE_KEY = 'velarumpay.prototype.displayPrefs.v1';

  const languages = [
    { code: 'en', english: 'English', native: 'English', dir: 'ltr' },
    { code: 'zh-Hans', english: 'Mandarin Chinese', native: '简体中文', dir: 'ltr' },
    { code: 'hi', english: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
    { code: 'es', english: 'Spanish', native: 'Español', dir: 'ltr' },
    { code: 'ar', english: 'Modern Standard Arabic', native: 'العربية الفصحى', dir: 'rtl' },
    { code: 'fr', english: 'French', native: 'Français', dir: 'ltr' },
    { code: 'bn', english: 'Bengali', native: 'বাংলা', dir: 'ltr' },
    { code: 'pt', english: 'Portuguese', native: 'Português', dir: 'ltr' },
    { code: 'id', english: 'Indonesian', native: 'Bahasa Indonesia', dir: 'ltr' },
    { code: 'ur', english: 'Urdu', native: 'اردو', dir: 'rtl' },
    { code: 'ru', english: 'Russian', native: 'Русский', dir: 'ltr' },
    { code: 'de', english: 'German', native: 'Deutsch', dir: 'ltr' },
    { code: 'ja', english: 'Japanese', native: '日本語', dir: 'ltr' },
    { code: 'pcm', english: 'Nigerian Pidgin', native: 'Naija', dir: 'ltr' },
    { code: 'arz', english: 'Egyptian Arabic', native: 'العربي المصري', dir: 'rtl' },
    { code: 'mr', english: 'Marathi', native: 'मराठी', dir: 'ltr' },
    { code: 'vi', english: 'Vietnamese', native: 'Tiếng Việt', dir: 'ltr' },
    { code: 'te', english: 'Telugu', native: 'తెలుగు', dir: 'ltr' },
    { code: 'sw', english: 'Swahili', native: 'Kiswahili', dir: 'ltr' },
    { code: 'ha', english: 'Hausa', native: 'Hausa', dir: 'ltr' },
    { code: 'tr', english: 'Turkish', native: 'Türkçe', dir: 'ltr' },
    { code: 'pnb', english: 'Western Punjabi', native: 'پنجابی', dir: 'rtl' },
    { code: 'fil', english: 'Tagalog / Filipino', native: 'Filipino', dir: 'ltr' },
    { code: 'ta', english: 'Tamil', native: 'தமிழ்', dir: 'ltr' },
    { code: 'yue-Hant', english: 'Yue Chinese / Cantonese', native: '粵語', dir: 'ltr' },
    { code: 'wuu-Hans', english: 'Wu Chinese', native: '吴语', dir: 'ltr' },
    { code: 'fa', english: 'Iranian Persian', native: 'فارسی', dir: 'rtl' },
    { code: 'ko', english: 'Korean', native: '한국어', dir: 'ltr' },
    { code: 'am', english: 'Amharic', native: 'አማርኛ', dir: 'ltr' },
    { code: 'th', english: 'Thai', native: 'ไทย', dir: 'ltr' }
  ];

  const fontSizes = [
    { id: 'small', scale: 0.92, label: 'A-' },
    { id: 'default', scale: 1, label: 'A' },
    { id: 'large', scale: 1.14, label: 'A+' },
    { id: 'xlarge', scale: 1.3, label: 'A++' }
  ];

  const copy = {
    en: {
      panelTitle: 'Display and language',
      panelSummary: 'Adjust prototype text size and switch among the top 30 global languages.',
      languageLabel: 'Language',
      fontSizeLabel: 'Text size',
      sampleText: 'Payment details stay readable before signing.',
      saved: 'Preferences saved',
      personalWallet: 'Personal wallet',
      home: 'Home',
      inbox: 'Inbox',
      profile: 'Profile',
      settings: 'Settings',
      displayLanguage: 'Display and language',
      languageCoverage: 'Top 30 global languages',
      languageCoverageBody: 'Prototype controls exercise locale, direction, and text-size behavior. Production strings use the translation workflow defined in the docs.',
      searchCryptoAssets: 'Search crypto assets',
      scanQrCode: 'Scan QR code'
    },
    'zh-Hans': {
      panelTitle: '显示与语言',
      panelSummary: '调整原型字号，并切换全球前 30 名语言。',
      languageLabel: '语言',
      fontSizeLabel: '字号',
      sampleText: '签名前，支付详情必须保持清晰可读。',
      saved: '偏好已保存',
      personalWallet: '个人钱包',
      home: '首页',
      inbox: '收件箱',
      profile: '个人中心',
      settings: '设置',
      displayLanguage: '显示与语言',
      languageCoverage: '全球前 30 名语言',
      languageCoverageBody: '原型控件用于验证语言、文字方向和字号行为；正式产品文案按文档定义的翻译流程交付。',
      searchCryptoAssets: '搜索加密资产',
      scanQrCode: '扫描二维码'
    },
    hi: {
      panelTitle: 'प्रदर्शन और भाषा',
      panelSummary: 'प्रोटोटाइप का पाठ आकार बदलें और शीर्ष 30 वैश्विक भाषाओं में स्विच करें।',
      languageLabel: 'भाषा',
      fontSizeLabel: 'पाठ आकार',
      sampleText: 'हस्ताक्षर से पहले भुगतान विवरण पढ़ने योग्य रहते हैं।',
      saved: 'पसंद सहेजी गई',
      personalWallet: 'व्यक्तिगत वॉलेट',
      home: 'होम',
      inbox: 'इनबॉक्स',
      profile: 'प्रोफ़ाइल',
      settings: 'सेटिंग्स',
      displayLanguage: 'प्रदर्शन और भाषा',
      languageCoverage: 'शीर्ष 30 वैश्विक भाषाएँ',
      languageCoverageBody: 'प्रोटोटाइप नियंत्रण locale, direction और text-size व्यवहार की जाँच करते हैं।',
      searchCryptoAssets: 'क्रिप्टो एसेट खोजें',
      scanQrCode: 'QR कोड स्कैन करें'
    },
    es: {
      panelTitle: 'Pantalla e idioma',
      panelSummary: 'Ajusta el tamaño del texto y cambia entre los 30 idiomas globales principales.',
      languageLabel: 'Idioma',
      fontSizeLabel: 'Tamaño de texto',
      sampleText: 'Los detalles de pago siguen legibles antes de firmar.',
      saved: 'Preferencias guardadas',
      personalWallet: 'Billetera personal',
      home: 'Inicio',
      inbox: 'Bandeja',
      profile: 'Perfil',
      settings: 'Ajustes',
      displayLanguage: 'Pantalla e idioma',
      languageCoverage: '30 idiomas globales principales',
      languageCoverageBody: 'Los controles del prototipo validan locale, dirección y tamaño de texto.',
      searchCryptoAssets: 'Buscar criptoactivos',
      scanQrCode: 'Escanear código QR'
    },
    ar: {
      panelTitle: 'العرض واللغة',
      panelSummary: 'غيّر حجم النص في النموذج وبدّل بين أكبر 30 لغة عالمية.',
      languageLabel: 'اللغة',
      fontSizeLabel: 'حجم النص',
      sampleText: 'تبقى تفاصيل الدفع مقروءة قبل التوقيع.',
      saved: 'تم حفظ التفضيلات',
      personalWallet: 'محفظة شخصية',
      home: 'الرئيسية',
      inbox: 'الوارد',
      profile: 'الملف',
      settings: 'الإعدادات',
      displayLanguage: 'العرض واللغة',
      languageCoverage: 'أكبر 30 لغة عالمية',
      languageCoverageBody: 'تتحقق عناصر التحكم من اللغة والاتجاه وحجم النص في النموذج.',
      searchCryptoAssets: 'البحث عن الأصول المشفرة',
      scanQrCode: 'مسح رمز QR'
    },
    fr: {
      panelTitle: 'Affichage et langue',
      panelSummary: 'Ajustez la taille du texte et changez parmi les 30 principales langues mondiales.',
      languageLabel: 'Langue',
      fontSizeLabel: 'Taille du texte',
      sampleText: 'Les détails de paiement restent lisibles avant la signature.',
      saved: 'Préférences enregistrées',
      personalWallet: 'Portefeuille personnel',
      home: 'Accueil',
      inbox: 'Boîte',
      profile: 'Profil',
      settings: 'Réglages',
      displayLanguage: 'Affichage et langue',
      languageCoverage: '30 principales langues mondiales',
      languageCoverageBody: 'Les contrôles du prototype valident la locale, la direction et la taille du texte.',
      searchCryptoAssets: 'Rechercher des crypto-actifs',
      scanQrCode: 'Scanner le code QR'
    },
    bn: {
      panelTitle: 'প্রদর্শন ও ভাষা',
      panelSummary: 'প্রোটোটাইপের লেখার আকার বদলান এবং শীর্ষ ৩০টি বৈশ্বিক ভাষা বেছে নিন।',
      languageLabel: 'ভাষা',
      fontSizeLabel: 'লেখার আকার',
      sampleText: 'স্বাক্ষরের আগে পেমেন্টের বিবরণ পড়ার মতো থাকে।',
      saved: 'পছন্দ সংরক্ষিত',
      personalWallet: 'ব্যক্তিগত ওয়ালেট',
      home: 'হোম',
      inbox: 'ইনবক্স',
      profile: 'প্রোফাইল',
      settings: 'সেটিংস',
      displayLanguage: 'প্রদর্শন ও ভাষা',
      languageCoverage: 'শীর্ষ ৩০টি বৈশ্বিক ভাষা',
      languageCoverageBody: 'প্রোটোটাইপ কন্ট্রোল locale, direction এবং text-size আচরণ যাচাই করে।',
      searchCryptoAssets: 'ক্রিপ্টো সম্পদ খুঁজুন',
      scanQrCode: 'QR কোড স্ক্যান করুন'
    },
    pt: {
      panelTitle: 'Tela e idioma',
      panelSummary: 'Ajuste o tamanho do texto e alterne entre os 30 principais idiomas globais.',
      languageLabel: 'Idioma',
      fontSizeLabel: 'Tamanho do texto',
      sampleText: 'Os detalhes do pagamento continuam legíveis antes da assinatura.',
      saved: 'Preferências salvas',
      personalWallet: 'Carteira pessoal',
      home: 'Início',
      inbox: 'Caixa',
      profile: 'Perfil',
      settings: 'Configurações',
      displayLanguage: 'Tela e idioma',
      languageCoverage: '30 principais idiomas globais',
      languageCoverageBody: 'Os controles do protótipo validam localidade, direção e tamanho do texto.',
      searchCryptoAssets: 'Buscar criptoativos',
      scanQrCode: 'Escanear QR code'
    },
    id: {
      panelTitle: 'Tampilan dan bahasa',
      panelSummary: 'Atur ukuran teks dan ganti di antara 30 bahasa global teratas.',
      languageLabel: 'Bahasa',
      fontSizeLabel: 'Ukuran teks',
      sampleText: 'Detail pembayaran tetap terbaca sebelum ditandatangani.',
      saved: 'Preferensi disimpan',
      personalWallet: 'Dompet pribadi',
      home: 'Beranda',
      inbox: 'Kotak masuk',
      profile: 'Profil',
      settings: 'Pengaturan',
      displayLanguage: 'Tampilan dan bahasa',
      languageCoverage: '30 bahasa global teratas',
      languageCoverageBody: 'Kontrol prototipe menguji locale, arah teks, dan ukuran teks.',
      searchCryptoAssets: 'Cari aset kripto',
      scanQrCode: 'Pindai kode QR'
    },
    ur: {
      panelTitle: 'ڈسپلے اور زبان',
      panelSummary: 'پروٹوٹائپ کا متن بڑا یا چھوٹا کریں اور دنیا کی 30 بڑی زبانوں میں بدلیں۔',
      languageLabel: 'زبان',
      fontSizeLabel: 'متن کا سائز',
      sampleText: 'دستخط سے پہلے ادائیگی کی تفصیل واضح رہتی ہے۔',
      saved: 'ترجیحات محفوظ ہو گئیں',
      personalWallet: 'ذاتی والیٹ',
      home: 'ہوم',
      inbox: 'ان باکس',
      profile: 'پروفائل',
      settings: 'ترتیبات',
      displayLanguage: 'ڈسپلے اور زبان',
      languageCoverage: 'دنیا کی 30 بڑی زبانیں',
      languageCoverageBody: 'پروٹوٹائپ کنٹرولز locale، سمت اور متن کے سائز کو جانچتے ہیں۔',
      searchCryptoAssets: 'کرپٹو اثاثے تلاش کریں',
      scanQrCode: 'QR کوڈ اسکین کریں'
    },
    ru: {
      panelTitle: 'Экран и язык',
      panelSummary: 'Настройте размер текста и переключайтесь между 30 крупнейшими языками мира.',
      languageLabel: 'Язык',
      fontSizeLabel: 'Размер текста',
      sampleText: 'Детали платежа остаются читаемыми перед подписью.',
      saved: 'Настройки сохранены',
      personalWallet: 'Личный кошелек',
      home: 'Главная',
      inbox: 'Входящие',
      profile: 'Профиль',
      settings: 'Настройки',
      displayLanguage: 'Экран и язык',
      languageCoverage: '30 крупнейших языков мира',
      languageCoverageBody: 'Контролы прототипа проверяют locale, направление и размер текста.',
      searchCryptoAssets: 'Искать криптоактивы',
      scanQrCode: 'Сканировать QR'
    },
    de: {
      panelTitle: 'Anzeige und Sprache',
      panelSummary: 'Passe die Textgröße an und wechsle zwischen den 30 weltweit größten Sprachen.',
      languageLabel: 'Sprache',
      fontSizeLabel: 'Textgröße',
      sampleText: 'Zahlungsdetails bleiben vor dem Signieren lesbar.',
      saved: 'Einstellungen gespeichert',
      personalWallet: 'Persönliche Wallet',
      home: 'Home',
      inbox: 'Eingang',
      profile: 'Profil',
      settings: 'Einstellungen',
      displayLanguage: 'Anzeige und Sprache',
      languageCoverage: 'Top 30 globale Sprachen',
      languageCoverageBody: 'Die Prototyp-Kontrollen prüfen Locale, Richtung und Textgröße.',
      searchCryptoAssets: 'Kryptoassets suchen',
      scanQrCode: 'QR-Code scannen'
    },
    ja: {
      panelTitle: '表示と言語',
      panelSummary: 'プロトタイプの文字サイズを調整し、世界上位30言語を切り替えます。',
      languageLabel: '言語',
      fontSizeLabel: '文字サイズ',
      sampleText: '署名前に支払い詳細を読みやすく保ちます。',
      saved: '設定を保存しました',
      personalWallet: '個人ウォレット',
      home: 'ホーム',
      inbox: '受信箱',
      profile: 'プロフィール',
      settings: '設定',
      displayLanguage: '表示と言語',
      languageCoverage: '世界上位30言語',
      languageCoverageBody: 'プロトタイプのコントロールで locale、方向、文字サイズを検証します。',
      searchCryptoAssets: '暗号資産を検索',
      scanQrCode: 'QRコードをスキャン'
    },
    pcm: {
      panelTitle: 'Display and language',
      panelSummary: 'Change text size and choose from di top 30 languages for di world.',
      languageLabel: 'Language',
      fontSizeLabel: 'Text size',
      sampleText: 'Payment details go dey clear before you sign.',
      saved: 'Settings don save',
      personalWallet: 'Personal wallet',
      home: 'Home',
      inbox: 'Inbox',
      profile: 'Profile',
      settings: 'Settings',
      displayLanguage: 'Display and language',
      languageCoverage: 'Top 30 world languages',
      languageCoverageBody: 'Prototype controls test locale, direction and text size.',
      searchCryptoAssets: 'Search crypto assets',
      scanQrCode: 'Scan QR code'
    },
    arz: {
      panelTitle: 'العرض واللغة',
      panelSummary: 'غيّر حجم الكلام في البروتوتايب واختار من أكبر 30 لغة.',
      languageLabel: 'اللغة',
      fontSizeLabel: 'حجم الكلام',
      sampleText: 'تفاصيل الدفع تفضل واضحة قبل التوقيع.',
      saved: 'اتحفظت التفضيلات',
      personalWallet: 'محفظة شخصية',
      home: 'الرئيسية',
      inbox: 'الوارد',
      profile: 'البروفايل',
      settings: 'الإعدادات',
      displayLanguage: 'العرض واللغة',
      languageCoverage: 'أكبر 30 لغة في العالم',
      languageCoverageBody: 'التحكمات بتجرب اللغة والاتجاه وحجم الكلام.',
      searchCryptoAssets: 'دور على أصول كريبتو',
      scanQrCode: 'امسح QR'
    },
    mr: {
      panelTitle: 'दृश्य आणि भाषा',
      panelSummary: 'मजकूराचा आकार बदला आणि जागतिक शीर्ष ३० भाषांमध्ये स्विच करा.',
      languageLabel: 'भाषा',
      fontSizeLabel: 'मजकूर आकार',
      sampleText: 'स्वाक्षरीपूर्वी पेमेंट तपशील वाचनीय राहतात.',
      saved: 'प्राधान्ये जतन झाली',
      personalWallet: 'वैयक्तिक वॉलेट',
      home: 'मुख्यपृष्ठ',
      inbox: 'इनबॉक्स',
      profile: 'प्रोफाइल',
      settings: 'सेटिंग्ज',
      displayLanguage: 'दृश्य आणि भाषा',
      languageCoverage: 'जागतिक शीर्ष ३० भाषा',
      languageCoverageBody: 'प्रोटोटाइप नियंत्रण locale, direction आणि text-size तपासतात.',
      searchCryptoAssets: 'क्रिप्टो मालमत्ता शोधा',
      scanQrCode: 'QR कोड स्कॅन करा'
    },
    vi: {
      panelTitle: 'Hiển thị và ngôn ngữ',
      panelSummary: 'Điều chỉnh cỡ chữ và chuyển giữa 30 ngôn ngữ toàn cầu hàng đầu.',
      languageLabel: 'Ngôn ngữ',
      fontSizeLabel: 'Cỡ chữ',
      sampleText: 'Chi tiết thanh toán vẫn dễ đọc trước khi ký.',
      saved: 'Đã lưu tùy chọn',
      personalWallet: 'Ví cá nhân',
      home: 'Trang chủ',
      inbox: 'Hộp thư',
      profile: 'Hồ sơ',
      settings: 'Cài đặt',
      displayLanguage: 'Hiển thị và ngôn ngữ',
      languageCoverage: '30 ngôn ngữ toàn cầu hàng đầu',
      languageCoverageBody: 'Điều khiển nguyên mẫu kiểm tra locale, hướng chữ và cỡ chữ.',
      searchCryptoAssets: 'Tìm tài sản crypto',
      scanQrCode: 'Quét mã QR'
    },
    te: {
      panelTitle: 'ప్రదర్శన మరియు భాష',
      panelSummary: 'ప్రోటోటైప్ టెక్స్ట్ పరిమాణాన్ని మార్చి, ప్రపంచ టాప్ 30 భాషల్లో ఎంచుకోండి.',
      languageLabel: 'భాష',
      fontSizeLabel: 'టెక్స్ట్ పరిమాణం',
      sampleText: 'సైన్ చేసే ముందు చెల్లింపు వివరాలు స్పష్టంగా ఉంటాయి.',
      saved: 'అభిరుచులు సేవ్ అయ్యాయి',
      personalWallet: 'వ్యక్తిగత వాలెట్',
      home: 'హోమ్',
      inbox: 'ఇన్‌బాక్స్',
      profile: 'ప్రొఫైల్',
      settings: 'సెట్టింగ్స్',
      displayLanguage: 'ప్రదర్శన మరియు భాష',
      languageCoverage: 'ప్రపంచ టాప్ 30 భాషలు',
      languageCoverageBody: 'ప్రోటోటైప్ నియంత్రణలు locale, direction, text-size ను పరీక్షిస్తాయి.',
      searchCryptoAssets: 'క్రిప్టో ఆస్తులను వెతకండి',
      scanQrCode: 'QR కోడ్ స్కాన్ చేయండి'
    },
    sw: {
      panelTitle: 'Mwonekano na lugha',
      panelSummary: 'Badilisha ukubwa wa maandishi na uchague kati ya lugha 30 kubwa duniani.',
      languageLabel: 'Lugha',
      fontSizeLabel: 'Ukubwa wa maandishi',
      sampleText: 'Maelezo ya malipo hubaki kusomeka kabla ya kusaini.',
      saved: 'Mapendeleo yamehifadhiwa',
      personalWallet: 'Mkoba binafsi',
      home: 'Nyumbani',
      inbox: 'Kikasha',
      profile: 'Wasifu',
      settings: 'Mipangilio',
      displayLanguage: 'Mwonekano na lugha',
      languageCoverage: 'Lugha 30 kubwa duniani',
      languageCoverageBody: 'Vidhibiti vya mfano hukagua locale, mwelekeo na ukubwa wa maandishi.',
      searchCryptoAssets: 'Tafuta mali za crypto',
      scanQrCode: 'Changanua QR'
    },
    ha: {
      panelTitle: 'Nuni da harshe',
      panelSummary: 'Daidaita girman rubutu kuma zaɓi daga manyan harsuna 30 na duniya.',
      languageLabel: 'Harshe',
      fontSizeLabel: 'Girman rubutu',
      sampleText: 'Bayanan biyan kuɗi suna kasancewa masu karantawa kafin sa hannu.',
      saved: 'An adana zaɓuɓɓuka',
      personalWallet: 'Jakarka ta sirri',
      home: 'Gida',
      inbox: 'Akwatin saƙo',
      profile: 'Bayanai',
      settings: 'Saituna',
      displayLanguage: 'Nuni da harshe',
      languageCoverage: 'Manyan harsuna 30 na duniya',
      languageCoverageBody: 'Kayan gwaji na prototype suna duba locale, direction da girman rubutu.',
      searchCryptoAssets: 'Nemo kadarorin crypto',
      scanQrCode: 'Duba lambar QR'
    },
    tr: {
      panelTitle: 'Görüntü ve dil',
      panelSummary: 'Metin boyutunu ayarlayın ve dünyanın en büyük 30 dili arasında geçiş yapın.',
      languageLabel: 'Dil',
      fontSizeLabel: 'Metin boyutu',
      sampleText: 'Ödeme ayrıntıları imzadan önce okunabilir kalır.',
      saved: 'Tercihler kaydedildi',
      personalWallet: 'Kişisel cüzdan',
      home: 'Ana sayfa',
      inbox: 'Gelen kutusu',
      profile: 'Profil',
      settings: 'Ayarlar',
      displayLanguage: 'Görüntü ve dil',
      languageCoverage: 'En büyük 30 küresel dil',
      languageCoverageBody: 'Prototip kontrolleri locale, yön ve metin boyutunu test eder.',
      searchCryptoAssets: 'Kripto varlık ara',
      scanQrCode: 'QR kodu tara'
    },
    pnb: {
      panelTitle: 'ڈسپلے تے زبان',
      panelSummary: 'لکھائی دا سائز بدلو تے دنیا دیاں 30 وڈیاں زباناں وچوں چنو۔',
      languageLabel: 'زبان',
      fontSizeLabel: 'لکھائی دا سائز',
      sampleText: 'دستخط توں پہلاں ادائیگی دی تفصیل صاف رہندی اے۔',
      saved: 'ترجیحات محفوظ ہو گئیاں',
      personalWallet: 'ذاتی والیٹ',
      home: 'ہوم',
      inbox: 'ان باکس',
      profile: 'پروفائل',
      settings: 'سیٹنگاں',
      displayLanguage: 'ڈسپلے تے زبان',
      languageCoverage: 'دنیا دیاں 30 وڈیاں زباناں',
      languageCoverageBody: 'پروٹوٹائپ کنٹرولز locale، سمت تے لکھائی دا سائز چیک کردے نیں۔',
      searchCryptoAssets: 'کرپٹو اثاثے لبھو',
      scanQrCode: 'QR کوڈ اسکین کرو'
    },
    fil: {
      panelTitle: 'Display at wika',
      panelSummary: 'Ayusin ang laki ng teksto at lumipat sa top 30 na pandaigdigang wika.',
      languageLabel: 'Wika',
      fontSizeLabel: 'Laki ng teksto',
      sampleText: 'Nananatiling nababasa ang detalye ng bayad bago pumirma.',
      saved: 'Na-save ang preferences',
      personalWallet: 'Personal na wallet',
      home: 'Home',
      inbox: 'Inbox',
      profile: 'Profile',
      settings: 'Settings',
      displayLanguage: 'Display at wika',
      languageCoverage: 'Top 30 na pandaigdigang wika',
      languageCoverageBody: 'Sinusubok ng prototype controls ang locale, direksyon, at laki ng teksto.',
      searchCryptoAssets: 'Maghanap ng crypto assets',
      scanQrCode: 'I-scan ang QR code'
    },
    ta: {
      panelTitle: 'காட்சி மற்றும் மொழி',
      panelSummary: 'உரை அளவை மாற்றி உலகின் முதல் 30 மொழிகளில் ஒன்றைத் தேர்ந்தெடுக்கவும்.',
      languageLabel: 'மொழி',
      fontSizeLabel: 'உரை அளவு',
      sampleText: 'கையொப்பத்திற்கு முன் கட்டண விவரங்கள் வாசிக்க எளிதாக இருக்கும்.',
      saved: 'விருப்பங்கள் சேமிக்கப்பட்டன',
      personalWallet: 'தனிப்பட்ட வாலெட்',
      home: 'முகப்பு',
      inbox: 'இன்பாக்ஸ்',
      profile: 'சுயவிவரம்',
      settings: 'அமைப்புகள்',
      displayLanguage: 'காட்சி மற்றும் மொழி',
      languageCoverage: 'உலகின் முதல் 30 மொழிகள்',
      languageCoverageBody: 'Prototype controls locale, direction, text-size நடத்தையைச் சரிபார்க்கும்.',
      searchCryptoAssets: 'கிரிப்டோ சொத்துகளைத் தேடு',
      scanQrCode: 'QR குறியீட்டை ஸ்கேன் செய்'
    },
    'yue-Hant': {
      panelTitle: '顯示同語言',
      panelSummary: '調整原型字體大小，切換全球前 30 大語言。',
      languageLabel: '語言',
      fontSizeLabel: '字體大小',
      sampleText: '簽署之前，付款資料要保持清楚易讀。',
      saved: '偏好已儲存',
      personalWallet: '個人錢包',
      home: '首頁',
      inbox: '收件箱',
      profile: '個人檔案',
      settings: '設定',
      displayLanguage: '顯示同語言',
      languageCoverage: '全球前 30 大語言',
      languageCoverageBody: '原型控制項用嚟驗證語言、方向同字體大小。',
      searchCryptoAssets: '搜尋加密資產',
      scanQrCode: '掃描 QR 碼'
    },
    'wuu-Hans': {
      panelTitle: '显示搭语言',
      panelSummary: '调节原型字号，并切换全球前 30 名语言。',
      languageLabel: '语言',
      fontSizeLabel: '字号',
      sampleText: '签名前，支付详情要保持清爽好读。',
      saved: '偏好已保存',
      personalWallet: '个人钱包',
      home: '首页',
      inbox: '收件箱',
      profile: '个人中心',
      settings: '设置',
      displayLanguage: '显示搭语言',
      languageCoverage: '全球前 30 名语言',
      languageCoverageBody: '原型控件用来验证语言、方向和字号。',
      searchCryptoAssets: '搜索加密资产',
      scanQrCode: '扫描二维码'
    },
    fa: {
      panelTitle: 'نمایش و زبان',
      panelSummary: 'اندازه متن نمونه را تنظیم کنید و میان ۳۰ زبان بزرگ جهان جابه‌جا شوید.',
      languageLabel: 'زبان',
      fontSizeLabel: 'اندازه متن',
      sampleText: 'جزئیات پرداخت پیش از امضا خوانا می‌ماند.',
      saved: 'ترجیحات ذخیره شد',
      personalWallet: 'کیف پول شخصی',
      home: 'خانه',
      inbox: 'صندوق',
      profile: 'نمایه',
      settings: 'تنظیمات',
      displayLanguage: 'نمایش و زبان',
      languageCoverage: '۳۰ زبان بزرگ جهان',
      languageCoverageBody: 'کنترل‌های نمونه locale، جهت و اندازه متن را می‌آزمایند.',
      searchCryptoAssets: 'جستجوی دارایی رمزنگاری',
      scanQrCode: 'اسکن QR'
    },
    ko: {
      panelTitle: '표시 및 언어',
      panelSummary: '프로토타입 글자 크기를 조정하고 전 세계 상위 30개 언어를 전환합니다.',
      languageLabel: '언어',
      fontSizeLabel: '글자 크기',
      sampleText: '서명 전에도 결제 세부 정보가 읽기 쉽게 유지됩니다.',
      saved: '환경설정이 저장되었습니다',
      personalWallet: '개인 지갑',
      home: '홈',
      inbox: '받은함',
      profile: '프로필',
      settings: '설정',
      displayLanguage: '표시 및 언어',
      languageCoverage: '전 세계 상위 30개 언어',
      languageCoverageBody: '프로토타입 컨트롤은 locale, 방향, 글자 크기를 검증합니다.',
      searchCryptoAssets: '암호화 자산 검색',
      scanQrCode: 'QR 코드 스캔'
    },
    am: {
      panelTitle: 'ማሳያ እና ቋንቋ',
      panelSummary: 'የጽሑፍ መጠንን ያስተካክሉ እና ከዓለም 30 ትልቅ ቋንቋዎች ይምረጡ።',
      languageLabel: 'ቋንቋ',
      fontSizeLabel: 'የጽሑፍ መጠን',
      sampleText: 'ከፊርማ በፊት የክፍያ ዝርዝሮች በቀላሉ ይነበባሉ።',
      saved: 'ምርጫዎች ተቀምጠዋል',
      personalWallet: 'የግል ዋሌት',
      home: 'መነሻ',
      inbox: 'ገቢ መልዕክት',
      profile: 'መገለጫ',
      settings: 'ቅንብሮች',
      displayLanguage: 'ማሳያ እና ቋንቋ',
      languageCoverage: 'የዓለም 30 ትልቅ ቋንቋዎች',
      languageCoverageBody: 'የprototype መቆጣጠሪያዎች locale፣ direction እና text-size ይፈትናሉ።',
      searchCryptoAssets: 'የcrypto ንብረቶችን ፈልግ',
      scanQrCode: 'QR ኮድ ይቃኙ'
    },
    th: {
      panelTitle: 'การแสดงผลและภาษา',
      panelSummary: 'ปรับขนาดข้อความและสลับระหว่าง 30 ภาษาหลักของโลก',
      languageLabel: 'ภาษา',
      fontSizeLabel: 'ขนาดข้อความ',
      sampleText: 'รายละเอียดการชำระเงินยังอ่านได้ชัดเจนก่อนลงนาม',
      saved: 'บันทึกค่ากำหนดแล้ว',
      personalWallet: 'กระเป๋าส่วนตัว',
      home: 'หน้าแรก',
      inbox: 'กล่องเข้า',
      profile: 'โปรไฟล์',
      settings: 'การตั้งค่า',
      displayLanguage: 'การแสดงผลและภาษา',
      languageCoverage: '30 ภาษาหลักของโลก',
      languageCoverageBody: 'ตัวควบคุมต้นแบบทดสอบ locale ทิศทาง และขนาดข้อความ',
      searchCryptoAssets: 'ค้นหาสินทรัพย์คริปโต',
      scanQrCode: 'สแกน QR'
    }
  };

  let prefs = loadPrefs();

  function loadPrefs() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      return normalizePrefs(stored);
    } catch (_) {
      return normalizePrefs({});
    }
  }

  function normalizePrefs(next) {
    const locale = languages.some(language => language.code === next.locale) ? next.locale : 'en';
    const fontSize = fontSizes.some(size => size.id === next.fontSize) ? next.fontSize : 'default';
    return { locale, fontSize };
  }

  function savePrefs() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  }

  function currentLanguage() {
    return languages.find(language => language.code === prefs.locale) || languages[0];
  }

  function currentFontSize() {
    return fontSizes.find(size => size.id === prefs.fontSize) || fontSizes[1];
  }

  function t(key) {
    const languageCopy = copy[prefs.locale] || copy.en;
    return languageCopy[key] || copy.en[key] || key;
  }

  function applyPrefs() {
    const language = currentLanguage();
    const size = currentFontSize();
    document.documentElement.lang = language.code;
    document.documentElement.dir = language.dir;
    document.documentElement.style.setProperty('--vp-prototype-font-scale', String(size.scale));
    document.documentElement.dataset.vpLocale = language.code;
    document.documentElement.dataset.vpFontSize = size.id;
    syncControls();
  }

  function setLocale(locale) {
    prefs = normalizePrefs({ ...prefs, locale });
    savePrefs();
    applyPrefs();
    notify();
  }

  function setFontSize(fontSize) {
    prefs = normalizePrefs({ ...prefs, fontSize });
    savePrefs();
    applyPrefs();
    notify();
  }

  function notify() {
    document.dispatchEvent(new CustomEvent('velarum:prototype-prefs-changed', {
      detail: { ...prefs, language: currentLanguage(), fontSize: currentFontSize() }
    }));
  }

  function languageOptions() {
    return languages.map(language => {
      const label = language.native === language.english
        ? language.native
        : language.native + ' / ' + language.english;
      return '<option value="' + escapeAttr(language.code) + '">' + escapeHtml(label) + '</option>';
    }).join('');
  }

  function renderSizeButtons() {
    return fontSizes.map(size => {
      return '<button class="vp-pref-size-button" type="button" data-vp-font-size="' + escapeAttr(size.id) + '">' + escapeHtml(size.label) + '</button>';
    }).join('');
  }

  function panelHtml() {
    return [
      '<details class="vp-pref-panel" aria-label="' + escapeAttr(t('displayLanguage')) + '">',
      '<summary aria-label="' + escapeAttr(t('displayLanguage')) + '">Aa</summary>',
      '<div class="vp-pref-panel__body">',
      '<div class="vp-pref-panel__head"><div><h2>' + escapeHtml(t('panelTitle')) + '</h2><p>' + escapeHtml(t('panelSummary')) + '</p></div><span class="vp-pref-chip">' + languages.length + '</span></div>',
      controlsHtml(),
      '</div>',
      '</details>'
    ].join('');
  }

  function controlsHtml() {
    return [
      '<div class="vp-pref-row">',
      '<label class="vp-pref-label" for="vp-pref-language">' + escapeHtml(t('languageLabel')) + '</label>',
      '<select id="vp-pref-language" class="vp-pref-select" data-vp-locale-select>' + languageOptions() + '</select>',
      '</div>',
      '<div class="vp-pref-row">',
      '<div class="vp-pref-label">' + escapeHtml(t('fontSizeLabel')) + '</div>',
      '<div class="vp-pref-size-grid">' + renderSizeButtons() + '</div>',
      '</div>',
      '<p>' + escapeHtml(t('sampleText')) + '</p>'
    ].join('');
  }

  function renderInlineControls() {
    const language = currentLanguage();
    return [
      '<div class="vp-pref-inline">',
      '<div><h3>' + escapeHtml(t('displayLanguage')) + '</h3><p>' + escapeHtml(t('languageCoverageBody')) + '</p><div class="vp-pref-meta"><span class="vp-pref-chip">' + escapeHtml(t('languageCoverage')) + '</span><span class="vp-pref-chip">' + escapeHtml(language.native) + '</span></div></div>',
      controlsHtml(),
      '</div>'
    ].join('');
  }

  function syncControls() {
    document.querySelectorAll('[data-vp-locale-select]').forEach(select => {
      select.value = prefs.locale;
    });
    document.querySelectorAll('[data-vp-font-size]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-vp-font-size') === prefs.fontSize));
    });
  }

  function mountPanel() {
    const existing = document.querySelector('.vp-pref-panel');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', panelHtml());
    syncControls();
  }

  function init(options = {}) {
    applyPrefs();
    if (options.panel === true) mountPanel();
  }

  document.addEventListener('change', event => {
    const select = event.target.closest('[data-vp-locale-select]');
    if (!select) return;
    setLocale(select.value);
  });

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-vp-font-size]');
    if (!button) return;
    setFontSize(button.getAttribute('data-vp-font-size'));
  });

  window.VelarumPrototypePrefs = {
    languages,
    fontSizes,
    init,
    t,
    getPrefs: () => ({ ...prefs }),
    getLanguage: currentLanguage,
    getFontSize: currentFontSize,
    setLocale,
    setFontSize,
    renderInlineControls
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }
})();
